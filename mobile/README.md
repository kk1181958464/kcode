# KCode Mobile

KCode 的 Android / iOS 客户端。应用使用 Flutter 提供统一原生外壳，任务、登录、实时输出和附件协议复用 `remote/` 服务。

## 本地运行

```powershell
cd mobile
flutter pub get
flutter run
```

默认连接 `https://kcode.98104.cn`。调试其他服务时使用：

```powershell
flutter run --dart-define=KCODE_REMOTE_URL=https://example.com
```

页面连接失败时可以在错误页修改服务器地址；该地址会保存在设备本地。

## 构建

```powershell
flutter analyze
flutter test
flutter build apk --release
flutter build appbundle --release
```

iOS 构建必须在安装 Xcode 的 macOS 上执行：

```bash
flutter build ios --release --no-codesign
```

商店发布前需要将 Android 调试签名替换为私有 release keystore，并在 Xcode 配置 Apple Team、Bundle ID 和分发证书。
