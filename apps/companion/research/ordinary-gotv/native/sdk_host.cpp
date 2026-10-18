// Optional in-process C ABI for driver.py. Link only to a legitimately obtained
// Valve steam_api library. No app-id files, credentials, tickets or keys on disk.
#include "steam_bridge.hpp"
#include <cstring>
#include <memory>
#ifdef _WIN32
#define OBS_API extern "C" __declspec(dllexport)
#else
#define OBS_API extern "C" __attribute__((visibility("default")))
#endif
using namespace mizar::observer;
namespace {
std::unique_ptr<SteamBridge> bridge;
bool initialized = false;
bool valid(void* handle) { return bridge && bridge.get() == handle; }
void shutdown() {
  bridge.reset(); // Cancel ticket, close connection, unregister callbacks first.
  if (initialized) { initialized = false; SteamAPI_Shutdown(); }
}
}
// One dedicated process, one SDK context, one session; call on its owning thread.
// Initialization may legitimately fail for App 730. Never substitute Spacewar or
// anonymous server credentials. Host must already have a legitimate app context.
OBS_API void* observer_create(const char* endpoint, std::uint64_t now_ms) noexcept {
  if (initialized || bridge || !endpoint) return nullptr;
  try {
    SteamNetworkingIPAddr address{};
    if (!address.ParseString(endpoint) || !address.m_port) return nullptr;
    SteamErrMsg error{}; // Never expose SDK diagnostic text (may contain local data).
    if (SteamAPI_InitEx(&error) != k_ESteamAPIInitResult_OK) return nullptr;
    initialized = true;
    auto* user = SteamUser(); auto* utils = SteamUtils(); auto* sockets = SteamNetworkingSockets();
    if (!user || !utils || !sockets || utils->GetAppID() != 730 || !user->BLoggedOn()) {
      shutdown(); return nullptr;
    }
    bridge = std::make_unique<SteamBridge>(*user, *utils, *sockets, address);
    bridge->session().start(now_ms);
    return bridge.get();
  } catch (...) { shutdown(); return nullptr; }
}
OBS_API int observer_state(void* handle) noexcept {
  return valid(handle) ? static_cast<int>(bridge->session().state()) : static_cast<int>(State::closed);
}
OBS_API int observer_failure(void* handle) noexcept {
  return valid(handle) ? static_cast<int>(bridge->session().failure()) : static_cast<int>(Failure::context);
}
OBS_API void observer_pump(void* handle, std::uint64_t now_ms) noexcept {
  if (!valid(handle)) return;
  try { bridge->pump(now_ms); } catch (...) { bridge->session().close(Failure::consumer); }
}
OBS_API std::uint64_t observer_remote_id(void* handle) noexcept {
  return valid(handle) ? bridge->remote_steam_id() : 0;
}
OBS_API int observer_request_ticket(void* handle) noexcept {
  if (!valid(handle)) return 0;
  try { bridge->session().request_ticket(); return bridge->session().state() == State::ticket_pending; }
  catch (...) { bridge->session().close(Failure::consumer); return 0; }
}
// Borrowed memory only; caller may use it to build connect, but must not log or
// persist it. Valid only while session is ready, before next SDK pump/close.
OBS_API const std::uint8_t* observer_auth(void* handle, std::uint32_t* size) noexcept {
  if (!size) return nullptr;
  *size = 0;
  if (!valid(handle)) return nullptr;
  try { const auto bytes = bridge->session().auth_steam(); *size = static_cast<std::uint32_t>(bytes.size()); return bytes.data(); }
  catch (...) { return nullptr; }
}
OBS_API int observer_send(void* handle, const std::uint8_t* bytes, std::uint32_t size, int reliable) noexcept {
  if (!valid(handle) || !bytes || !size || (reliable != 0 && reliable != 1)) return 0;
  return bridge->send({bytes, size}, reliable ? k_nSteamNetworkingSend_Reliable : k_nSteamNetworkingSend_Unreliable) == k_EResultOK;
}
OBS_API int observer_receive(void* handle, std::uint8_t* output, std::uint32_t capacity, int* reliable) noexcept {
  if (!valid(handle) || !output || !capacity || !reliable) return -1;
  int bytes = 0;
  try {
    const int count = bridge->receive([&](std::span<const std::uint8_t> message, bool r) {
      if (message.size() > capacity || message.empty()) throw std::length_error("message-budget");
      std::memcpy(output, message.data(), message.size());
      bytes = static_cast<int>(message.size()); *reliable = r ? 1 : 0;
    });
    return count < 0 ? -1 : bytes;
  } catch (...) { return -1; }
}
OBS_API void observer_close(void* handle) noexcept { if (valid(handle)) shutdown(); }
