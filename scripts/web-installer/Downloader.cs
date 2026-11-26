using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace Mizar.WebInstaller {
  sealed class DistributionConfig {
    public string[] githubReleaseProxies;
    public int sampleBytes;
    public int probeTimeoutMs;
    public int firstByteMs;
    public int stallMs;
    public int metadataMs;

    internal static DistributionConfig Load() {
      using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("distribution.json")) {
        if (stream == null)
          throw new InvalidDataException("缺少嵌入的分发配置 distribution.json。");
        using (var reader = new StreamReader(stream, Encoding.UTF8)) {
          var raw = new JavaScriptSerializer { MaxJsonLength = 65536 }.Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
          if (raw == null || !raw.ContainsKey("githubReleaseProxies") || !raw.ContainsKey("probe") || !raw.ContainsKey("timeouts"))
            throw new InvalidDataException("嵌入的分发配置 distribution.json 格式无效。");
          var list = raw["githubReleaseProxies"] as System.Collections.ArrayList;
          var probe = raw["probe"] as Dictionary<string, object>;
          var timeouts = raw["timeouts"] as Dictionary<string, object>;
          if (list == null || probe == null || timeouts == null ||
              !probe.ContainsKey("sampleBytes") || !probe.ContainsKey("timeoutMs") ||
              !timeouts.ContainsKey("firstByteMs") || !timeouts.ContainsKey("stallMs") || !timeouts.ContainsKey("metadataMs"))
            throw new InvalidDataException("嵌入的分发配置 distribution.json 字段不完整。");

          var proxies = new List<string>();
          foreach (object item in list) {
            string s = item as string;
            if (String.IsNullOrEmpty(s))
              throw new InvalidDataException("分发配置中的代理地址无效。");
            proxies.Add(s);
          }

          var config = new DistributionConfig {
            githubReleaseProxies = proxies.ToArray(),
            sampleBytes = Convert.ToInt32(probe["sampleBytes"]),
            probeTimeoutMs = Convert.ToInt32(probe["timeoutMs"]),
            firstByteMs = Convert.ToInt32(timeouts["firstByteMs"]),
            stallMs = Convert.ToInt32(timeouts["stallMs"]),
            metadataMs = Convert.ToInt32(timeouts["metadataMs"]),
          };
          if (config.sampleBytes < 1 || config.probeTimeoutMs < 1 ||
              config.firstByteMs < 1 || config.stallMs < 1 || config.metadataMs < 1)
            throw new InvalidDataException("分发配置中的超时或探测参数无效。");
          return config;
        }
      }
    }
  }

  public sealed class LocalStorageException : IOException {
    public LocalStorageException(string message, Exception inner) : base(message, inner) { }
  }

  public sealed class Downloader {
    const int OfficialMetadataTimeoutMs = 8000;
    readonly HttpClient client;
    readonly Action<string> diagnostic;
    static readonly DistributionConfig Config = DistributionConfig.Load();

    public Downloader(HttpClient value) : this(value, null) { }

    public Downloader(HttpClient value, Action<string> diagnosticCallback) {
      client = value;
      diagnostic = diagnosticCallback;
    }

    void EmitDiagnostic(string message) {
      if (diagnostic != null && !String.IsNullOrEmpty(message)) {
        diagnostic(message);
      }
    }

    public static bool Allowed(Uri u) {
      return ValidateHttpsUri(u) &&
        ((u.Host == "github.com" && u.AbsolutePath.StartsWith("/Starfie1d1272/Mizar/releases/download/", StringComparison.Ordinal)) ||
         u.Host == "release-assets.githubusercontent.com");
    }

    internal static bool ValidateHttpsUri(Uri u) {
      if (u == null || !u.IsAbsoluteUri) return false;
      if (u.Scheme != "https" || !u.IsDefaultPort || !String.IsNullOrEmpty(u.UserInfo) || !String.IsNullOrEmpty(u.Fragment))
        return false;
      string host = u.DnsSafeHost.ToLowerInvariant();
      if (String.IsNullOrEmpty(host) || host == "localhost" || host.EndsWith(".localhost", StringComparison.Ordinal))
        return false;
      IPAddress ip;
      if (IPAddress.TryParse(host, out ip)) return false;
      return true;
    }

    internal static string[] BuildSources(string[] origins) {
      var list = new List<string>();
      foreach (string origin in origins) {
        if (String.IsNullOrEmpty(origin)) continue;
        list.Add(origin);
        Uri uri;
        if (Uri.TryCreate(origin, UriKind.Absolute, out uri) && Allowed(uri) && uri.Host == "github.com" && String.IsNullOrEmpty(uri.Query)) {
          foreach (string proxy in Config.githubReleaseProxies) {
            Uri proxyUri;
            if (Uri.TryCreate(proxy, UriKind.Absolute, out proxyUri) && ValidateHttpsUri(proxyUri)) {
              list.Add(proxyUri.AbsoluteUri.TrimEnd('/') + "/" + uri.AbsoluteUri);
            }
          }
        }
      }
      return list.ToArray();
    }

    internal static void NoReparse(string path) {
      for (string p = Path.GetFullPath(path); p != null; p = Path.GetDirectoryName(p)) {
        if ((Directory.Exists(p) || File.Exists(p)) &&
            (File.GetAttributes(p) & FileAttributes.ReparsePoint) != 0)
          throw new IOException("缓存路径不能包含链接。");
      }
    }

    static async Task<bool> MatchesAsync(string path, Plan plan, CancellationToken token) {
      NoReparse(path);
      token.ThrowIfCancellationRequested();
      if (!File.Exists(path)) return false;
      using (var input = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 65536, true))
        return await MatchesStream(input, plan, token).ConfigureAwait(false);
    }

    internal static async Task<bool> MatchesStream(FileStream input, Plan plan, CancellationToken token) {
      if (input.Length != plan.bytes) return false;
      input.Position = 0;
      using (var sha = SHA256.Create()) {
        var buffer = new byte[65536];
        for (;;) {
          int count = await input.ReadAsync(buffer, 0, buffer.Length, token).ConfigureAwait(false);
          if (count == 0) break;
          sha.TransformBlock(buffer, 0, count, buffer, 0);
        }
        token.ThrowIfCancellationRequested();
        sha.TransformFinalBlock(new byte[0], 0, 0);
        return BitConverter.ToString(sha.Hash).Replace("-", "").ToLowerInvariant() == plan.sha256;
      }
    }

    async Task<HttpResponseMessage> Request(string url, long? rangeEnd, CancellationToken token) {
      Uri current = new Uri(url);
      if (!ValidateHttpsUri(current)) throw new InvalidDataException("下载地址不受信任。");
      string initialOrigin = current.GetLeftPart(UriPartial.Authority);

      for (int n = 0; n <= 5; n++) {
        token.ThrowIfCancellationRequested();
        if (!ValidateHttpsUri(current)) throw new InvalidDataException("下载重定向地址不受信任。");
        bool sameOrigin = String.Equals(current.GetLeftPart(UriPartial.Authority), initialOrigin, StringComparison.OrdinalIgnoreCase);

        using (var request = new HttpRequestMessage(HttpMethod.Get, current)) {
          request.Headers.TryAddWithoutValidation("User-Agent", "Mizar-WebInstaller");
          request.Headers.TryAddWithoutValidation("Accept-Encoding", "identity");
          if (rangeEnd.HasValue) {
            request.Headers.Range = new RangeHeaderValue(0, rangeEnd.Value);
          }
          if (!sameOrigin) {
            request.Headers.Remove("Authorization");
            request.Headers.Remove("Proxy-Authorization");
            request.Headers.Remove("Cookie");
          }

          HttpResponseMessage response;
          using (var headers = CancellationTokenSource.CreateLinkedTokenSource(token)) {
            headers.CancelAfter(Config.firstByteMs);
            try {
              response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, headers.Token).ConfigureAwait(false);
            } catch (OperationCanceledException error) {
              token.ThrowIfCancellationRequested();
              throw new HttpRequestException("下载源连接超时。", error);
            }
          }

          int status = (int)response.StatusCode;
          if (status == 301 || status == 302 || status == 303 || status == 307 || status == 308) {
            var location = response.Headers.Location;
            response.Dispose();
            if (location == null) throw new InvalidDataException("下载重定向无效。");
            if (n == 5) throw new InvalidDataException("下载重定向次数超限。");
            current = location.IsAbsoluteUri ? location : new Uri(current, location);
            continue;
          }

          if (status != 200 && status != 206) {
            response.Dispose();
            if (status == 408 || status == 429 || status >= 500)
              throw new HttpRequestException("下载源暂时不可用 (HTTP " + status + ")。");
            throw new InvalidDataException("下载源不可用 (HTTP " + status + ")。");
          }

          if (response.Content.Headers.ContentEncoding.Count != 0) {
            response.Dispose();
            throw new InvalidDataException("下载源响应编码无效。");
          }

          var mediaType = response.Content.Headers.ContentType != null ? response.Content.Headers.ContentType.MediaType : null;
          if (mediaType != null && mediaType.IndexOf("text/html", StringComparison.OrdinalIgnoreCase) >= 0) {
            response.Dispose();
            throw new InvalidDataException("下载源返回了网页而非目标文件。");
          }

          return response;
        }
      }
      throw new InvalidDataException("下载重定向次数超限。");
    }

    sealed class ProbeResult {
      public int Index;
      public string Source;
      public long ElapsedMs;
      public bool Ok;
      public string Reason;
    }

    async Task<int[]> ProbeOrderAsync(string[] sources, long expectedBytes, CancellationToken token) {
      if (sources.Length <= 1) return sources.Length == 1 ? new[] { 0 } : new int[0];
      long sample = Math.Min(expectedBytes, (long)Config.sampleBytes);
      var tasks = new Task<ProbeResult>[sources.Length];
      for (int i = 0; i < sources.Length; i++) {
        int index = i;
        string source = sources[i];
        tasks[i] = ProbeSingleAsync(index, source, sample, expectedBytes, token);
      }
      ProbeResult[] results = await Task.WhenAll(tasks).ConfigureAwait(false);
      token.ThrowIfCancellationRequested();

      Array.Sort(results, delegate(ProbeResult a, ProbeResult b) {
        if (a.Ok != b.Ok) return a.Ok ? -1 : 1;
        int cmp = a.ElapsedMs.CompareTo(b.ElapsedMs);
        return cmp != 0 ? cmp : a.Index.CompareTo(b.Index);
      });

      var order = new int[results.Length];
      var summary = new StringBuilder();
      for (int i = 0; i < results.Length; i++) {
        order[i] = results[i].Index;
        if (i > 0) summary.Append("; ");
        summary.Append(results[i].Source).Append(": ");
        if (results[i].Ok) summary.Append(results[i].ElapsedMs).Append("ms");
        else summary.Append("failed(").Append(results[i].Reason).Append(")");
      }
      EmitDiagnostic("Source probe order: " + summary.ToString());
      return order;
    }

    async Task<ProbeResult> ProbeSingleAsync(int index, string source, long sample, long expectedBytes, CancellationToken token) {
      var sw = Stopwatch.StartNew();
      using (var timeout = CancellationTokenSource.CreateLinkedTokenSource(token)) {
        timeout.CancelAfter(Config.probeTimeoutMs);
        try {
          using (var response = await Request(source, sample - 1, timeout.Token).ConfigureAwait(false))
          using (var abortRead = timeout.Token.Register(response.Dispose)) {
            int status = (int)response.StatusCode;
            if (status == 206) {
              var range = response.Content.Headers.ContentRange;
              if (range == null || range.Unit != "bytes" || range.From != 0 || range.To != sample - 1 ||
                  (range.Length.HasValue && range.Length.Value != expectedBytes)) {
                return new ProbeResult { Index = index, Source = source, ElapsedMs = long.MaxValue, Ok = false, Reason = "invalid Content-Range" };
              }
            } else if (status == 200) {
              if (response.Content.Headers.ContentLength.HasValue && response.Content.Headers.ContentLength.Value != expectedBytes) {
                return new ProbeResult { Index = index, Source = source, ElapsedMs = long.MaxValue, Ok = false, Reason = "invalid Content-Length" };
              }
            }

            using (var input = await response.Content.ReadAsStreamAsync().ConfigureAwait(false)) {
              var buffer = new byte[16384];
              long received = 0;
              while (received < sample) {
                int toRead = (int)Math.Min((long)buffer.Length, sample - received);
                int count = await input.ReadAsync(buffer, 0, toRead, timeout.Token).ConfigureAwait(false);
                if (count == 0) {
                  return new ProbeResult { Index = index, Source = source, ElapsedMs = long.MaxValue, Ok = false, Reason = "incomplete sample" };
                }
                received += count;
              }
            }
          }
          sw.Stop();
          return new ProbeResult { Index = index, Source = source, ElapsedMs = sw.ElapsedMilliseconds, Ok = true };
        } catch (Exception error) {
          token.ThrowIfCancellationRequested();
          return new ProbeResult { Index = index, Source = source, ElapsedMs = long.MaxValue, Ok = false, Reason = error.Message };
        }
      }
    }

    internal async Task FetchAndVerifyMetadata(string origin, CancellationToken token, Action<string> verify) {
      var sources = BuildSources(new[] { origin });
      var failures = new List<Exception>();

      // Official-first (8s), then parallel proxy race.
      string official = sources[0];
      int officialBudget = Math.Min(OfficialMetadataTimeoutMs, Config.metadataMs);
      using (var officialCts = CancellationTokenSource.CreateLinkedTokenSource(token)) {
        officialCts.CancelAfter(officialBudget);
        try {
          string json = await ReadMetadata(official, officialCts.Token).ConfigureAwait(false);
          verify(json);
          EmitDiagnostic("Metadata verified from: " + official);
          return;
        } catch (Exception error) {
          token.ThrowIfCancellationRequested();
          failures.Add(error);
          EmitDiagnostic("Metadata attempt failed (" + official + "): " + error.Message);
        }
      }

      if (sources.Length > 1) {
        using (var raceCts = CancellationTokenSource.CreateLinkedTokenSource(token)) {
          raceCts.CancelAfter(Config.metadataMs);
          var pending = new List<Task<string>>();
          for (int i = 1; i < sources.Length; i++) {
            string proxySource = sources[i];
            pending.Add(TryMetadataSourceAsync(proxySource, raceCts.Token, verify));
          }

          while (pending.Count > 0) {
            Task<string> finished = await Task.WhenAny(pending).ConfigureAwait(false);
            pending.Remove(finished);
            if (finished.Status == TaskStatus.RanToCompletion) {
              raceCts.Cancel();
              EmitDiagnostic("Metadata verified from: " + finished.Result);
              return;
            }
            token.ThrowIfCancellationRequested();
            if (finished.Exception != null) {
              foreach (var inner in finished.Exception.InnerExceptions) {
                failures.Add(inner);
                EmitDiagnostic("Metadata proxy failed: " + inner.Message);
              }
            }
          }
        }
      }

      throw new IOException("发布资料验证失败，请检查网络后重试。", new AggregateException(failures));
    }

    async Task<string> TryMetadataSourceAsync(string source, CancellationToken token, Action<string> verify) {
      string json = await ReadMetadata(source, token).ConfigureAwait(false);
      verify(json);
      return source;
    }

    async Task<string> ReadMetadata(string url, CancellationToken token) {
      using (var response = await Request(url, null, token).ConfigureAwait(false))
      using (var abortRead = token.Register(response.Dispose))
      using (var input = await response.Content.ReadAsStreamAsync().ConfigureAwait(false))
      using (var output = new MemoryStream()) {
        const int maximum = 16 * 1024 * 1024;
        if (response.Content.Headers.ContentLength.HasValue && response.Content.Headers.ContentLength.Value > maximum)
          throw new InvalidDataException("版本元数据超限。");
        var buffer = new byte[16384];
        for (;;) {
          int count = await input.ReadAsync(buffer, 0, buffer.Length, token).ConfigureAwait(false);
          if (count == 0) break;
          if (output.Length + count > maximum) throw new InvalidDataException("版本元数据超限。");
          output.Write(buffer, 0, count);
        }
        token.ThrowIfCancellationRequested();
        return new UTF8Encoding(false, true).GetString(output.ToArray());
      }
    }

    static void DiscardFile(string path) {
      try {
        NoReparse(path);
        if (File.Exists(path)) File.Delete(path);
      } catch { }
    }

    public async Task<string> Download(Plan plan, string cache, IProgress<long> progress, CancellationToken token, IProgress<string> stages = null) {
      if (stages != null) stages.Report("checking-cache");
      plan.Validate();
      token.ThrowIfCancellationRequested();

      string target;
      FileStream gate;
      try {
        cache = Path.GetFullPath(cache);
        NoReparse(cache);
        Directory.CreateDirectory(cache);
        NoReparse(cache);
        target = Path.Combine(cache, plan.sha256 + "-" + plan.name);
        NoReparse(target + ".lock");
        gate = new FileStream(target + ".lock", FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
      } catch (Exception error) {
        if (error is UnauthorizedAccessException || error is IOException)
          throw new LocalStorageException("无法访问或创建本地下载缓存目录。", error);
        throw;
      }

      using (gate) {
        bool cachedMatch;
        try {
          cachedMatch = await MatchesAsync(target, plan, token).ConfigureAwait(false);
        } catch (Exception error) {
          if (error is UnauthorizedAccessException || error is IOException)
            throw new LocalStorageException("无法读取本地下载缓存。", error);
          throw;
        }
        if (cachedMatch) {
          token.ThrowIfCancellationRequested();
          progress.Report(plan.bytes);
          EmitDiagnostic("Reused verified installer cache: " + target);
          return target;
        }

        string staging = target + ".part";
        DiscardFile(staging);

        var sources = BuildSources(plan.urls);
        if (stages != null) stages.Report("connecting-download");
        int[] order = await ProbeOrderAsync(sources, plan.bytes, token).ConfigureAwait(false);
        var failures = new List<Exception>();

        foreach (int index in order) {
          string url = sources[index];
          token.ThrowIfCancellationRequested();
          try {
            if (stages != null) stages.Report("connecting-download");
            using (var response = await Request(url, null, token).ConfigureAwait(false)) {
              if (response.Content.Headers.ContentLength.HasValue && response.Content.Headers.ContentLength.Value != plan.bytes)
                throw new InvalidDataException("下载文件大小不匹配。");
              if (response.Content.Headers.ContentRange != null)
                throw new InvalidDataException("完整下载响应包含无效范围。");

              FileStream output;
              try {
                output = new FileStream(staging, FileMode.Create, FileAccess.Write, FileShare.None, 65536, true);
              } catch (Exception error) {
                throw new LocalStorageException("无法创建本地暂存文件。", error);
              }

              using (var stallCts = CancellationTokenSource.CreateLinkedTokenSource(token))
              using (var abortRead = stallCts.Token.Register(response.Dispose))
              using (var input = await response.Content.ReadAsStreamAsync().ConfigureAwait(false))
              using (output) {
                if (stages != null) stages.Report("downloading-core");
                progress.Report(0);
                var buffer = new byte[65536];
                long total = 0;
                try {
                  for (;;) {
                    stallCts.CancelAfter(Config.stallMs);
                    int count;
                    try {
                      count = await input.ReadAsync(buffer, 0, buffer.Length, stallCts.Token).ConfigureAwait(false);
                    } catch (OperationCanceledException error) {
                      token.ThrowIfCancellationRequested();
                      throw new HttpRequestException("下载源长时间无响应（已停滞）。", error);
                    }
                    if (count == 0) break;
                    if (count > plan.bytes - total) throw new InvalidDataException("下载文件超过大小上限。");
                    try {
                      await output.WriteAsync(buffer, 0, count, token).ConfigureAwait(false);
                    } catch (Exception error) {
                      if (error is UnauthorizedAccessException || error is IOException)
                        throw new LocalStorageException("写入本地暂存文件失败。", error);
                      throw;
                    }
                    total += count;
                    progress.Report(total);
                  }
                } finally {
                  try { output.Flush(true); }
                  catch (Exception error) {
                    if (error is UnauthorizedAccessException || error is IOException)
                      EmitDiagnostic("Local staging flush warning: " + error.Message);
                  }
                }
                if (total != plan.bytes) throw new IOException("下载文件不完整。");
              }
            }

            token.ThrowIfCancellationRequested();
            if (stages != null) stages.Report("validating-download");
            bool verified;
            try {
              verified = await MatchesAsync(staging, plan, token).ConfigureAwait(false);
            } catch (Exception error) {
              if (error is UnauthorizedAccessException || error is IOException)
                throw new LocalStorageException("校验本地暂存文件失败。", error);
              throw;
            }
            if (!verified) throw new InvalidDataException("文件校验失败。");

            token.ThrowIfCancellationRequested();
            try {
              NoReparse(target);
              if (File.Exists(target)) File.Delete(target);
              File.Move(staging, target);
            } catch (Exception error) {
              if (error is UnauthorizedAccessException || error is IOException)
                throw new LocalStorageException("无法保存已验证的安装包到本地缓存。", error);
              throw;
            }

            progress.Report(plan.bytes);
            EmitDiagnostic("Download verified from: " + url);
            return target;
          } catch (LocalStorageException) {
            DiscardFile(staging);
            throw;
          } catch (UnauthorizedAccessException error) {
            DiscardFile(staging);
            throw new LocalStorageException("本地文件访问被拒绝。", error);
          } catch (Exception error) {
            DiscardFile(staging);
            token.ThrowIfCancellationRequested();
            failures.Add(error);
            EmitDiagnostic("Download failed (" + url + "): " + error.Message);
          }
        }

        throw new IOException("所有下载源均未通过验证。请重试或使用完整离线安装包。", new AggregateException(failures));
      }
    }
  }
}
