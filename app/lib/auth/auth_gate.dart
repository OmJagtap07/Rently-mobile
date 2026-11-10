import 'package:flutter/material.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'auth_flow.dart';
import 'onboarding_screen.dart';
import '../dashboards/landlord_dashboard_screen.dart';
import '../dashboards/tenant_dashboard_screen.dart';

class AuthGate extends StatefulWidget {
  const AuthGate({super.key});

  @override
  State<AuthGate> createState() => _AuthGateState();
}

class _AuthGateState extends State<AuthGate> {
  // Key to force rebuild of the stream builder when onboarding completes
  Key _gateKey = UniqueKey();

  void _reloadGate() {
    setState(() {
      _gateKey = UniqueKey();
    });
  }

  @override
  Widget build(BuildContext context) {
    return StreamBuilder<User?>(
      key: _gateKey,
      stream: FirebaseAuth.instance.authStateChanges(),
      builder: (context, authSnapshot) {
        if (authSnapshot.connectionState == ConnectionState.waiting) {
          return const Scaffold(body: Center(child: CircularProgressIndicator()));
        }

        final user = authSnapshot.data;

        if (user == null) {
          return const AuthFlow();
        }

        return FutureBuilder<DocumentSnapshot>(
          future: FirebaseFirestore.instance.collection('users').doc(user.uid).get(),
          builder: (context, userDocSnapshot) {
            if (userDocSnapshot.connectionState == ConnectionState.waiting) {
              return const Scaffold(body: Center(child: CircularProgressIndicator()));
            }

            if (userDocSnapshot.hasError) {
              return Scaffold(
                body: Center(child: Text('Error loading user data: ${userDocSnapshot.error}')),
              );
            }

            if (userDocSnapshot.hasData && userDocSnapshot.data!.exists) {
              final data = userDocSnapshot.data!.data() as Map<String, dynamic>;
              final role = data['role'] as String?;

              if (role == 'landlord') {
                return const LandlordDashboardScreen();
              } else if (role == 'tenant') {
                return const TenantDashboardScreen();
              } else {
                return const Scaffold(body: Center(child: Text('Unknown role in user document.')));
              }
            }

            // Document doesn't exist -> user needs to onboard
            return OnboardingScreen(onOnboarded: _reloadGate);
          },
        );
      },
    );
  }
}
