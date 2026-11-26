using System;
using System.Collections.Generic;
using System.IO;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace Mizar.WebInstaller {
  public sealed class Plan {
    public int schemaVersion;
    public string version, name, sha256, kind, gitSha, contentDigest;
    public long bytes;
    public string[] urls;
    public bool allowExecute, publicationRequired;
    public string coreName, coreSha256, updateManifestSha256;
    public long coreBytes;

    public void Validate() {
      if (schemaVersion != 1 || String.IsNullOrEmpty(version) ||
          String.IsNullOrEmpty(name) || name != Path.GetFileName(name) ||
          !Regex.IsMatch(name, @"^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$") ||
          bytes < 1 || bytes > 512L * 1024 * 1024 ||
          sha256 == null || !Regex.IsMatch(sha256, "^[a-f0-9]{64}$") ||
          urls == null || urls.Length < 1 || urls.Length > 4)
        throw new InvalidDataException("引导计划无效，或缺少正式安装授权。");
      if (allowExecute && (kind != "nsis-setup" ||
          !Regex.IsMatch(version, @"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$") ||
          (name != "Mizar-v" + version + "-Windows-x64-Setup.exe" && name != "Mizar-v" + version + "-Windows-x64-Core-Setup.exe") ||
          gitSha == null || !Regex.IsMatch(gitSha, "^[a-f0-9]{40}$") ||
          contentDigest == null || !Regex.IsMatch(contentDigest, "^[a-f0-9]{64}$")))
        throw new InvalidDataException("固定 NSIS 安装授权不完整。");
      foreach (string url in urls) {
        if (!Downloader.Allowed(new Uri(url)))
          throw new InvalidDataException("下载地址不受信任。");
      }
    }
  }

  // This only checks public availability of already-qualified pins. Publisher
  // authentication remains the existing Qualification and SDK trust chain.
  static class Publication {
    internal static void ValidatePlan(Plan plan) {
      plan.Validate();
      if (plan.updateManifestSha256 != null &&
          (!Regex.IsMatch(plan.updateManifestSha256, "^[a-f0-9]{64}$") ||
           plan.name != "Mizar-v" + plan.version + "-Windows-x64-Core-Setup.exe" ||
           plan.coreName != "Mizar-v" + plan.version + "-Windows-x64-Core.zip"))
        throw new InvalidDataException("Core qualification pins are invalid");
      if (!plan.allowExecute || !plan.publicationRequired ||
          (plan.coreName != "Mizar-v" + plan.version + "-Windows-x64.zip" &&
           plan.coreName != "Mizar-v" + plan.version + "-Windows-x64-Core.zip") ||
          plan.coreBytes < 1 || plan.coreSha256 == null ||
          !Regex.IsMatch(plan.coreSha256, "^[a-f0-9]{64}$") ||
          plan.urls.Length != 1 ||
          plan.urls[0] != "https://github.com/Starfie1d1272/Mizar/releases/download/v" + plan.version + "/" + plan.name)
        throw new InvalidDataException("正式安装身份不完整。");
    }

    internal static async Task Verify(Plan plan, CancellationToken token, Action<string> diagnostic = null) {
      using (var handler = new HttpClientHandler { AllowAutoRedirect = false, UseCookies = false })
      using (var client = new HttpClient(handler) { Timeout = Timeout.InfiniteTimeSpan }) {
        await Verify(plan, client, token, diagnostic).ConfigureAwait(false);
      }
    }

    internal static async Task Verify(Plan plan, HttpClient client, CancellationToken token, Action<string> diagnostic = null) {
      ValidatePlan(plan);
      string url = "https://github.com/Starfie1d1272/Mizar/releases/download/v" + plan.version + "/machine-metadata.json";
      await new Downloader(client, diagnostic).FetchAndVerifyMetadata(url, token, delegate(string json) {
        CheckIndex(IndexFromMachine(json), plan);
      }).ConfigureAwait(false);
    }

    internal static void CheckIndex(string json, Plan plan) {
      var serializer = new JavaScriptSerializer { MaxJsonLength = 2 * 1024 * 1024 };
      var index = serializer.Deserialize<Dictionary<string, object>>(json);
      if (index == null || !index.ContainsKey("schemaVersion") || !Object.Equals(index["schemaVersion"], "mizar.update-index.v2") ||
          !index.ContainsKey("provenance") || !index.ContainsKey("publicationProvenance") ||
          !index.ContainsKey("manifestBase64") || !index.ContainsKey("publicationBase64"))
        throw new InvalidDataException("发布资料不完整。");
      byte[] original = Convert.FromBase64String((string)index["manifestBase64"]);
      byte[] published = Convert.FromBase64String((string)index["publicationBase64"]);
      if (original.Length > 65536 || published.Length > 65536)
        throw new InvalidDataException("发布元数据超限。");
      var manifest = serializer.Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(original));
      var publication = serializer.Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(published));
      var installer = (Dictionary<string, object>)manifest["installer"];
      bool corePlan = plan.updateManifestSha256 != null;
      string digest;
      using (var sha = SHA256.Create()) {
        digest = BitConverter.ToString(sha.ComputeHash(original)).Replace("-", "").ToLowerInvariant();
      }
      DateTimeOffset time;
      if (!Object.Equals(manifest["repository"], "Starfie1d1272/Mizar") ||
          !Object.Equals(manifest["schemaVersion"], "mizar.update.v1") ||
          !Object.Equals(manifest["channel"], "stable") ||
          !Object.Equals(manifest["version"], plan.version) ||
          !Object.Equals(manifest["gitSha"], plan.gitSha) ||
          (corePlan
            ? !Object.Equals(plan.updateManifestSha256, digest)
            : !Object.Equals(installer["name"], plan.name) ||
              Convert.ToInt64(installer["bytes"]) != plan.bytes ||
              !Object.Equals(installer["sha256"], plan.sha256) ||
              !Object.Equals(installer["contentDigest"], plan.contentDigest)) ||
          !Object.Equals(publication["schemaVersion"], "mizar.update-publication.v1") ||
          !Object.Equals(publication["repository"], "Starfie1d1272/Mizar") ||
          !Object.Equals(publication["version"], plan.version) ||
          !Object.Equals(publication["gitSha"], plan.gitSha) ||
          !Object.Equals(publication["manifestSha256"], digest) ||
          Convert.ToInt64(publication["releaseId"]) < 1 ||
          !DateTimeOffset.TryParse((string)publication["publishedAt"], out time) ||
          time > DateTimeOffset.UtcNow)
        throw new InvalidDataException("发布资料与固定资格版本不一致。");
    }

    internal static string IndexFromMachine(string json) {
      var carrier = new JavaScriptSerializer { MaxJsonLength = 16 * 1024 * 1024 }.Deserialize<Dictionary<string, object>>(json);
      if (carrier == null || !carrier.ContainsKey("schemaVersion") ||
          !Object.Equals(carrier["schemaVersion"], "mizar.machine-metadata.v1") ||
          !carrier.ContainsKey("files"))
        throw new InvalidDataException("版本元数据无效。");
      var files = carrier["files"] as System.Collections.ArrayList;
      if (files == null || files.Count > 32)
        throw new InvalidDataException("版本元数据超限。");
      string encoded = null;
      foreach (object item in files) {
        var file = item as Dictionary<string, object>;
        if (file == null || !file.ContainsKey("name") || !file.ContainsKey("bytesBase64"))
          throw new InvalidDataException("版本元数据项无效。");
        if (Object.Equals(file["name"], "update-index.json")) {
          if (encoded != null) throw new InvalidDataException("发布索引重复。");
          encoded = file["bytesBase64"] as string;
          if (encoded == null || encoded.Length > 2800000)
            throw new InvalidDataException("发布索引无效。");
        }
      }
      if (encoded == null) throw new InvalidDataException("该版本缺少发布索引。");
      byte[] bytes = Convert.FromBase64String(encoded);
      if (bytes.Length > 2 * 1024 * 1024 || Convert.ToBase64String(bytes) != encoded)
        throw new InvalidDataException("发布索引编码无效。");
      return new UTF8Encoding(false, true).GetString(bytes);
    }
  }
}
