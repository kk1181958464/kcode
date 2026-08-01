import 'package:flutter_test/flutter_test.dart';
import 'package:kcode_mobile/remote_endpoint.dart';

void main() {
  group('normalizeRemoteUrl', () {
    test('adds HTTPS to a bare host', () {
      expect(
        normalizeRemoteUrl('kcode.98104.cn').toString(),
        'https://kcode.98104.cn/',
      );
    });

    test('removes paths, query parameters, and fragments', () {
      expect(
        normalizeRemoteUrl('https://example.com/admin?tab=1#users').toString(),
        'https://example.com/',
      );
    });

    test('rejects a cleartext HTTP endpoint', () {
      expect(
        () => normalizeRemoteUrl('http://192.168.1.8:8787'),
        throwsFormatException,
      );
    });

    test('keeps an explicit HTTPS port', () {
      expect(
        normalizeRemoteUrl('https://example.com:9443/path').toString(),
        'https://example.com:9443/',
      );
    });

    test('rejects unsupported schemes', () {
      expect(
        () => normalizeRemoteUrl('file:///tmp/kcode'),
        throwsFormatException,
      );
    });

    test('rejects credentials embedded in the URL', () {
      expect(
        () => normalizeRemoteUrl('https://user:pass@example.com'),
        throwsFormatException,
      );
    });
  });
}
