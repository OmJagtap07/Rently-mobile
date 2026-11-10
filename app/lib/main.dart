import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:cloud_functions/cloud_functions.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import 'firebase_options.dart';
import 'auth/auth_gate.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  await Firebase.initializeApp(
    options: DefaultFirebaseOptions.currentPlatform,
  );

  if (kDebugMode) {
    _connectToFirebaseEmulators();
  }

  runApp(const RentlyApp());
}

void _connectToFirebaseEmulators() {
  // Use 10.0.2.2 for Android emulator, 127.0.0.1 for iOS simulator and web
  String emulatorHost = 'localhost';
  if (!kIsWeb && defaultTargetPlatform == TargetPlatform.android) {
    emulatorHost = '10.0.2.2';
  }

  FirebaseAuth.instance.useAuthEmulator(emulatorHost, 9099);

  FirebaseFirestore.instance.useFirestoreEmulator(
    emulatorHost,
    8080,
  );

  FirebaseFunctions.instance.useFunctionsEmulator(
    emulatorHost,
    5001,
  );
}

class RentlyApp extends StatelessWidget {
  const RentlyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Rently',
      debugShowCheckedModeBanner: false,
      home: const AuthGate(),
    );
  }
}
