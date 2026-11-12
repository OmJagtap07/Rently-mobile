import 'package:firebase_auth/firebase_auth.dart';
import 'package:cloud_functions/cloud_functions.dart';
import 'package:google_sign_in/google_sign_in.dart' as gsign;
import 'package:flutter/foundation.dart';

import '../notifications/notification_service.dart';

class AuthService {
  final FirebaseAuth _auth = FirebaseAuth.instance;
  final FirebaseFunctions _functions = FirebaseFunctions.instance;
  final gsign.GoogleSignIn _googleSignIn = gsign.GoogleSignIn();

  Future<UserCredential> registerWithEmail(
    String email,
    String password,
  ) async {
    return await _auth.createUserWithEmailAndPassword(
      email: email,
      password: password,
    );
  }

  Future<UserCredential> signInWithEmail(String email, String password) async {
    return await _auth.signInWithEmailAndPassword(
      email: email,
      password: password,
    );
  }

  Future<UserCredential?> signInWithGoogle() async {
    try {
      final gsign.GoogleSignInAccount? googleUser = await _googleSignIn
          .signIn();
      if (googleUser == null) return null;

      final gsign.GoogleSignInAuthentication googleAuth =
          await googleUser.authentication;

      final OAuthCredential credential = GoogleAuthProvider.credential(
        accessToken: googleAuth.accessToken,
        idToken: googleAuth.idToken,
      );

      return await _auth.signInWithCredential(credential);
    } catch (e) {
      debugPrint('Google sign-in error: $e');
      rethrow;
    }
  }

  Future<void> completeOnboarding({
    required String role,
    required String fullName,
    required String phone,
  }) async {
    try {
      final callable = _functions.httpsCallable('completeOnboarding');
      await callable.call({'role': role, 'fullName': fullName, 'phone': phone});
      await _auth.currentUser?.getIdToken(true);
    } catch (e) {
      debugPrint('Onboarding error: $e');
      rethrow;
    }
  }

  Future<void> signOut() async {
    try {
      await NotificationService.instance.unregisterCurrentToken();
    } catch (error) {
      debugPrint('Device-token cleanup will be retried after sign-in: $error');
    } finally {
      try {
        await _googleSignIn.signOut();
      } finally {
        await _auth.signOut();
      }
    }
  }
}
