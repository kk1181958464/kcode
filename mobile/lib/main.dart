import 'dart:async';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:webview_flutter/webview_flutter.dart';
import 'package:webview_flutter_android/webview_flutter_android.dart';
import 'package:webview_flutter_wkwebview/webview_flutter_wkwebview.dart';

import 'remote_endpoint.dart';

const _ink = Color(0xff202126);
const _muted = Color(0xff737782);
const _line = Color(0xffe2e4e9);
const _surface = Color(0xffffffff);
const _surfaceSoft = Color(0xfff8f9fb);
const _accent = Color(0xff5b5fe8);

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge);
  SystemChrome.setSystemUIOverlayStyle(
    const SystemUiOverlayStyle(
      statusBarColor: Colors.transparent,
      statusBarIconBrightness: Brightness.dark,
      systemNavigationBarColor: _surface,
      systemNavigationBarIconBrightness: Brightness.dark,
      systemNavigationBarDividerColor: _line,
    ),
  );
  runApp(const KCodeMobileApp());
}

class KCodeMobileApp extends StatefulWidget {
  const KCodeMobileApp({super.key, this.endpointStore});

  final RemoteEndpointStore? endpointStore;

  @override
  State<KCodeMobileApp> createState() => _KCodeMobileAppState();
}

class _KCodeMobileAppState extends State<KCodeMobileApp> {
  late final RemoteEndpointStore _endpointStore;
  late final Future<Uri> _endpoint;

  @override
  void initState() {
    super.initState();
    _endpointStore = widget.endpointStore ?? RemoteEndpointStore();
    _endpoint = _loadEndpoint();
  }

  Future<Uri> _loadEndpoint() async {
    try {
      return await _endpointStore.load();
    } catch (_) {
      return normalizeRemoteUrl(defaultRemoteUrl);
    }
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'KCode',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        useMaterial3: true,
        colorScheme: ColorScheme.fromSeed(
          seedColor: _accent,
          brightness: Brightness.light,
          surface: _surface,
        ),
        scaffoldBackgroundColor: _surface,
        fontFamilyFallback: const ['PingFang SC', 'Microsoft YaHei'],
      ),
      home: FutureBuilder<Uri>(
        future: _endpoint,
        builder: (context, snapshot) {
          final endpoint = snapshot.data;
          if (endpoint == null) return const _LaunchView();
          return RemoteControlScreen(
            initialEndpoint: endpoint,
            endpointStore: _endpointStore,
          );
        },
      ),
    );
  }
}

class RemoteControlScreen extends StatefulWidget {
  const RemoteControlScreen({
    super.key,
    required this.initialEndpoint,
    required this.endpointStore,
  });

  final Uri initialEndpoint;
  final RemoteEndpointStore endpointStore;

  @override
  State<RemoteControlScreen> createState() => _RemoteControlScreenState();
}

class _RemoteControlScreenState extends State<RemoteControlScreen>
    with WidgetsBindingObserver {
  late final WebViewController _controller;
  late Uri _endpoint;
  int _progress = 0;
  String? _loadError;
  bool _pageReady = false;
  bool _choosingFiles = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _endpoint = widget.initialEndpoint;
    _controller = _buildController();
    unawaited(_controller.loadRequest(_endpoint));
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed && _pageReady) {
      unawaited(
        _controller.runJavaScript(
          "window.dispatchEvent(new Event('focus'));"
          "window.dispatchEvent(new Event('online'));",
        ),
      );
    }
  }

  WebViewController _buildController() {
    final PlatformWebViewControllerCreationParams params;
    if (WebViewPlatform.instance is WebKitWebViewPlatform) {
      params = WebKitWebViewControllerCreationParams(
        allowsInlineMediaPlayback: true,
        mediaTypesRequiringUserAction: const <PlaybackMediaTypes>{},
      );
    } else {
      params = const PlatformWebViewControllerCreationParams();
    }

    final controller = WebViewController.fromPlatformCreationParams(params)
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setBackgroundColor(_surface)
      ..setNavigationDelegate(
        NavigationDelegate(
          onProgress: (progress) {
            if (!mounted) return;
            setState(() => _progress = progress);
          },
          onPageStarted: (_) {
            if (!mounted) return;
            setState(() {
              _loadError = null;
              _pageReady = false;
              _progress = 0;
            });
          },
          onPageFinished: (_) {
            if (!mounted) return;
            setState(() {
              _pageReady = _loadError == null;
              _progress = 100;
            });
          },
          onWebResourceError: (error) {
            if (error.isForMainFrame != true || !mounted) return;
            setState(() {
              _loadError = error.description;
              _pageReady = false;
            });
          },
          onNavigationRequest: (request) {
            final uri = Uri.tryParse(request.url);
            if (uri == null || uri.scheme != 'https') {
              return NavigationDecision.prevent;
            }
            return NavigationDecision.navigate;
          },
        ),
      );

    final platform = controller.platform;
    if (platform is AndroidWebViewController) {
      unawaited(platform.setAllowFileAccess(true));
      unawaited(platform.setAllowContentAccess(true));
      unawaited(platform.setOnShowFileSelector(_selectAndroidFiles));
    } else if (platform is WebKitWebViewController) {
      unawaited(platform.setAllowsBackForwardNavigationGestures(true));
    }

    return controller;
  }

  Future<List<String>> _selectAndroidFiles(FileSelectorParams params) async {
    if (_choosingFiles) return const [];
    _choosingFiles = true;
    try {
      final accepted = params.acceptTypes
          .expand((value) => value.split(','))
          .map((value) => value.trim().toLowerCase())
          .where((value) => value.isNotEmpty)
          .toList();
      final imagesOnly =
          accepted.isNotEmpty &&
          accepted.every(
            (value) => value == 'image/*' || value.startsWith('image/'),
          );
      final result = await FilePicker.platform.pickFiles(
        allowMultiple: params.mode == FileSelectorMode.openMultiple,
        type: imagesOnly ? FileType.image : FileType.any,
        withData: false,
      );
      if (result == null) return const [];
      return result.files
          .map((file) => file.path)
          .whereType<String>()
          .map((path) => Uri.file(path).toString())
          .toList(growable: false);
    } finally {
      _choosingFiles = false;
    }
  }

  Future<bool> _returnToTaskList() async {
    try {
      final result = await _controller.runJavaScriptReturningResult(r'''
        (() => {
          const button = document.querySelector(
            'button[title="返回任务列表"]'
          );
          if (!button) return false;
          const style = window.getComputedStyle(button);
          if (style.display === 'none' || style.visibility === 'hidden') {
            return false;
          }
          button.click();
          return true;
        })()
      ''');
      return result == true || result.toString().toLowerCase() == 'true';
    } catch (_) {
      return false;
    }
  }

  Future<void> _handleBack() async {
    if (await _returnToTaskList()) return;
    if (await _controller.canGoBack()) {
      await _controller.goBack();
      return;
    }
    await SystemNavigator.pop();
  }

  Future<void> _reload() async {
    setState(() {
      _loadError = null;
      _pageReady = false;
    });
    await _controller.loadRequest(_endpoint);
  }

  Future<void> _showEndpointEditor() async {
    final textController = TextEditingController(text: _endpoint.toString());
    String? validationError;
    final next = await showModalBottomSheet<Uri>(
      context: context,
      isScrollControlled: true,
      backgroundColor: _surface,
      showDragHandle: true,
      builder: (context) => StatefulBuilder(
        builder: (context, setSheetState) {
          return Padding(
            padding: EdgeInsets.fromLTRB(
              20,
              4,
              20,
              20 + MediaQuery.viewInsetsOf(context).bottom,
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Text(
                  '服务器地址',
                  style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
                ),
                const SizedBox(height: 14),
                TextField(
                  controller: textController,
                  autofocus: true,
                  keyboardType: TextInputType.url,
                  textInputAction: TextInputAction.done,
                  autocorrect: false,
                  enableSuggestions: false,
                  decoration: InputDecoration(
                    hintText: 'https://kcode.98104.cn',
                    errorText: validationError,
                    prefixIcon: const Icon(Icons.dns_outlined, size: 20),
                    border: const OutlineInputBorder(),
                  ),
                  onSubmitted: (_) => _saveEndpoint(
                    context,
                    textController.text,
                    setSheetState,
                    (error) => validationError = error,
                  ),
                ),
                const SizedBox(height: 14),
                FilledButton.icon(
                  onPressed: () => _saveEndpoint(
                    context,
                    textController.text,
                    setSheetState,
                    (error) => validationError = error,
                  ),
                  icon: const Icon(Icons.check, size: 18),
                  label: const Text('保存并连接'),
                ),
              ],
            ),
          );
        },
      ),
    );
    textController.dispose();
    if (next == null || !mounted) return;
    await widget.endpointStore.save(next);
    _endpoint = next;
    await _reload();
  }

  void _saveEndpoint(
    BuildContext sheetContext,
    String value,
    StateSetter setSheetState,
    void Function(String?) setValidationError,
  ) {
    try {
      final endpoint = normalizeRemoteUrl(value);
      Navigator.of(sheetContext).pop(endpoint);
    } on FormatException catch (error) {
      setSheetState(() => setValidationError(error.message));
    }
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (_, _) => unawaited(_handleBack()),
      child: AnnotatedRegion<SystemUiOverlayStyle>(
        value: const SystemUiOverlayStyle(
          statusBarColor: Colors.transparent,
          statusBarIconBrightness: Brightness.dark,
          systemNavigationBarColor: _surface,
          systemNavigationBarIconBrightness: Brightness.dark,
        ),
        child: Scaffold(
          body: SafeArea(
            child: Stack(
              children: [
                Positioned.fill(child: WebViewWidget(controller: _controller)),
                if (_progress < 100 && _loadError == null)
                  Positioned(
                    top: 0,
                    left: 0,
                    right: 0,
                    child: LinearProgressIndicator(
                      value: _progress > 0 ? _progress / 100 : null,
                      minHeight: 2,
                      backgroundColor: Colors.transparent,
                      color: _accent,
                    ),
                  ),
                if (_loadError != null)
                  Positioned.fill(
                    child: _ConnectionErrorView(
                      details: _loadError!,
                      onRetry: _reload,
                      onSettings: _showEndpointEditor,
                    ),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _LaunchView extends StatelessWidget {
  const _LaunchView();

  @override
  Widget build(BuildContext context) {
    return const Scaffold(
      body: SafeArea(
        child: Center(
          child: SizedBox.square(
            dimension: 58,
            child: ClipRRect(
              borderRadius: BorderRadius.all(Radius.circular(12)),
              child: Image(image: AssetImage('assets/kcode-icon.png')),
            ),
          ),
        ),
      ),
    );
  }
}

class _ConnectionErrorView extends StatelessWidget {
  const _ConnectionErrorView({
    required this.details,
    required this.onRetry,
    required this.onSettings,
  });

  final String details;
  final Future<void> Function() onRetry;
  final Future<void> Function() onSettings;

  @override
  Widget build(BuildContext context) {
    return ColoredBox(
      color: _surfaceSoft,
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 360),
          child: Padding(
            padding: const EdgeInsets.all(28),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const SizedBox.square(
                  dimension: 62,
                  child: ClipRRect(
                    borderRadius: BorderRadius.all(Radius.circular(13)),
                    child: Image(
                      image: AssetImage('assets/kcode-icon.png'),
                      fit: BoxFit.cover,
                    ),
                  ),
                ),
                const SizedBox(height: 20),
                const Text(
                  '连接不到 KCode',
                  style: TextStyle(
                    color: _ink,
                    fontSize: 17,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                const SizedBox(height: 8),
                Text(
                  details,
                  maxLines: 3,
                  overflow: TextOverflow.ellipsis,
                  textAlign: TextAlign.center,
                  style: const TextStyle(
                    color: _muted,
                    fontSize: 12,
                    height: 1.5,
                  ),
                ),
                const SizedBox(height: 20),
                Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    OutlinedButton.icon(
                      onPressed: onSettings,
                      icon: const Icon(Icons.tune, size: 17),
                      label: const Text('设置'),
                    ),
                    const SizedBox(width: 10),
                    FilledButton.icon(
                      onPressed: onRetry,
                      icon: const Icon(Icons.refresh, size: 17),
                      label: const Text('重试'),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
