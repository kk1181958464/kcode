import 'package:shared_preferences/shared_preferences.dart';

const String defaultRemoteUrl = String.fromEnvironment(
  'KCODE_REMOTE_URL',
  defaultValue: 'https://kcode.98104.cn',
);

Uri normalizeRemoteUrl(String value) {
  var candidate = value.trim();
  if (candidate.isEmpty) {
    throw const FormatException('请输入服务器地址');
  }
  if (!candidate.contains('://')) {
    candidate = 'https://$candidate';
  }

  final uri = Uri.tryParse(candidate);
  if (uri == null ||
      !uri.hasAuthority ||
      uri.host.isEmpty ||
      uri.userInfo.isNotEmpty ||
      uri.scheme != 'https') {
    throw const FormatException('请输入有效的 HTTPS 地址');
  }

  return Uri(
    scheme: uri.scheme,
    userInfo: uri.userInfo,
    host: uri.host,
    port: uri.hasPort ? uri.port : null,
    path: '/',
  );
}

class RemoteEndpointStore {
  RemoteEndpointStore({SharedPreferencesAsync? preferences})
    : _preferences = preferences ?? SharedPreferencesAsync();

  static const _storageKey = 'kcode.remote.endpoint';
  final SharedPreferencesAsync _preferences;

  Future<Uri> load() async {
    final stored = await _preferences.getString(_storageKey);
    try {
      return normalizeRemoteUrl(stored ?? defaultRemoteUrl);
    } on FormatException {
      return normalizeRemoteUrl(defaultRemoteUrl);
    }
  }

  Future<void> save(Uri endpoint) async {
    await _preferences.setString(_storageKey, endpoint.toString());
  }
}
