import 'dart:async';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:cloud_functions/cloud_functions.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import 'firebase_options.dart';
import 'auth/auth_gate.dart';
import 'notifications/notification_service.dart';
import 'notifications/notification_message_handler.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  late final FirebaseOptions options;
  try {
    options = DefaultFirebaseOptions.currentPlatform;
  } on UnsupportedError catch (error) {
    runApp(
      FirebaseConfigurationRequiredApp(message: error.message ?? '$error'),
    );
    return;
  }
  await Firebase.initializeApp(options: options);

  if (kDebugMode) {
    _connectToFirebaseEmulators();
  }

  await NotificationService.instance.initialize();
  runApp(const RentlyApp());
}

void _connectToFirebaseEmulators() {
  // Use 10.0.2.2 for Android emulator, 127.0.0.1 for iOS simulator and web
  String emulatorHost = 'localhost';
  if (!kIsWeb && defaultTargetPlatform == TargetPlatform.android) {
    emulatorHost = '10.0.2.2';
  }

  FirebaseAuth.instance.useAuthEmulator(emulatorHost, 9099);

  FirebaseFirestore.instance.useFirestoreEmulator(emulatorHost, 8080);

  FirebaseFunctions.instance.useFunctionsEmulator(emulatorHost, 5001);
}

class RentlyApp extends StatelessWidget {
  const RentlyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Rently',
      debugShowCheckedModeBanner: false,
      home: const AuthGate(),
      builder: (context, child) =>
          _NotificationFeedbackHost(child: child ?? const SizedBox.shrink()),
    );
  }
}

class FirebaseConfigurationRequiredApp extends StatelessWidget {
  const FirebaseConfigurationRequiredApp({required this.message, super.key});

  final String message;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Rently setup required',
      home: Scaffold(
        appBar: AppBar(title: const Text('Firebase setup required')),
        body: Padding(
          padding: const EdgeInsets.all(24),
          child: ListView(
            children: [
              Text(message),
              const SizedBox(height: 16),
              const Text(
                'Register this app in Firebase Console using the iOS bundle '
                'identifier from the Runner Xcode target, then add the '
                'downloaded GoogleService-Info.plist to ios/Runner. Run '
                'FlutterFire configuration again with the real iOS app '
                'credentials. For push, enable the Push Notifications and '
                'Background Modes capabilities and configure an APNs '
                'authentication key in Firebase Console.',
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _NotificationFeedbackHost extends StatefulWidget {
  const _NotificationFeedbackHost({required this.child});

  final Widget child;

  @override
  State<_NotificationFeedbackHost> createState() =>
      _NotificationFeedbackHostState();
}

class _NotificationFeedbackHostState extends State<_NotificationFeedbackHost> {
  StreamSubscription<NotificationMessageEvent>? _foregroundSubscription;
  StreamSubscription<NotificationMessageEvent>? _openedSubscription;

  @override
  void initState() {
    super.initState();
    final service = NotificationService.instance;
    _foregroundSubscription = service.foregroundEvents.listen(
      _showNotificationFeedback,
    );
    _openedSubscription = service.openedEvents.listen(
      _showNotificationFeedback,
    );
    WidgetsBinding.instance.addPostFrameCallback((_) {
      unawaited(service.handleInitialMessage());
    });
  }

  @override
  void dispose() {
    final foregroundSubscription = _foregroundSubscription;
    final openedSubscription = _openedSubscription;
    if (foregroundSubscription != null) {
      unawaited(foregroundSubscription.cancel());
    }
    if (openedSubscription != null) {
      unawaited(openedSubscription.cancel());
    }
    super.dispose();
  }

  void _showNotificationFeedback(NotificationMessageEvent event) {
    final messenger = ScaffoldMessenger.maybeOf(context);
    if (messenger == null) return;
    final message = event.title ?? event.body ?? 'Notification received';
    messenger
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(message)));
  }

  @override
  Widget build(BuildContext context) => widget.child;
}
