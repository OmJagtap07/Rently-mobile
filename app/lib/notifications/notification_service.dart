import 'dart:async';

import 'package:cloud_functions/cloud_functions.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';

import 'device_token_ownership.dart';
import 'notification_message_handler.dart';

class NotificationService {
  NotificationService._();

  static final NotificationService instance = NotificationService._();

  static const _webVapidKey = String.fromEnvironment('FCM_WEB_VAPID_KEY');

  final FirebaseAuth _auth = FirebaseAuth.instance;
  final FirebaseFunctions _functions = FirebaseFunctions.instance;
  final NotificationSubscriptionLifecycle _subscriptions =
      NotificationSubscriptionLifecycle();
  final DeviceTokenOwnershipManager _tokenOwnership =
      DeviceTokenOwnershipManager(
        store: SecureDeviceTokenOwnershipStore(),
        register: (uid, token) => instance._registerToken(uid, token),
        unregister: (uid, token) => instance._unregisterToken(uid, token),
        authenticatedUid: () => instance._auth.currentUser?.uid,
      );
  NotificationMessageCoordinator? _messageCoordinator;
  String? _eligibleUserId;
  int _authGeneration = 0;
  bool _initialMessageChecked = false;

  Stream<NotificationMessageEvent> get foregroundEvents =>
      _messages.foregroundEvents;
  Stream<NotificationMessageEvent> get openedEvents => _messages.openedEvents;

  NotificationMessageCoordinator get _messages =>
      _messageCoordinator ??= NotificationMessageCoordinator();

  FirebaseMessaging get _messaging => FirebaseMessaging.instance;

  Future<void> initialize() async {
    if (_subscriptions.isStarted) return;
    final messagingSupported = _supportsMessagingPlatform;
    _subscriptions.start<User?>(
      authChanges: _auth.idTokenChanges(),
      tokenRefreshes: messagingSupported
          ? _messaging.onTokenRefresh
          : const Stream<String>.empty(),
      foregroundMessages: messagingSupported
          ? FirebaseMessaging.onMessage
          : const Stream<RemoteMessage>.empty(),
      openedMessages: messagingSupported
          ? FirebaseMessaging.onMessageOpenedApp
          : const Stream<RemoteMessage>.empty(),
      onAuthChanged: (user) => unawaited(_handleUserChangedSafely(user)),
      onTokenRefresh: (token) => unawaited(_handleTokenRefresh(token)),
      onForegroundMessage: _messages.handleForeground,
      onOpenedMessage: _messages.handleOpened,
      onError: (error, stackTrace) {
        debugPrint('Notification listener error: $error');
      },
    );

    if (messagingSupported &&
        !kIsWeb &&
        defaultTargetPlatform == TargetPlatform.iOS) {
      await _messaging.setForegroundNotificationPresentationOptions(
        alert: false,
        badge: false,
        sound: false,
      );
    }
  }

  Future<void> handleInitialMessage() async {
    if (_initialMessageChecked || !_supportsMessagingPlatform) return;
    _initialMessageChecked = true;
    try {
      final message = await _messaging.getInitialMessage();
      if (message != null) _messages.handleOpened(message);
    } catch (error) {
      debugPrint('Unable to read the initial notification message: $error');
    }
  }

  Future<void> unregisterCurrentToken() async {
    final uid = _auth.currentUser?.uid;
    _authGeneration++;
    _eligibleUserId = null;
    if (uid == null) {
      await _tokenOwnership.authenticatedUserChanged(null);
      return;
    }
    await _tokenOwnership.prepareForSignOut(uid);
  }

  Future<void> dispose() async {
    _authGeneration++;
    _eligibleUserId = null;
    await _subscriptions.dispose();
    await _messageCoordinator?.dispose();
    _messageCoordinator = null;
    _initialMessageChecked = false;
  }

  Future<void> _handleUserChanged(User? user) async {
    final generation = ++_authGeneration;
    if (user == null) {
      _eligibleUserId = null;
      await _tokenOwnership.authenticatedUserChanged(null);
      return;
    }

    final claims = (await user.getIdTokenResult()).claims;
    final role = claims?['role'];
    if (role != 'landlord' && role != 'tenant') {
      _eligibleUserId = null;
      await _tokenOwnership.authenticatedUserChanged(user.uid);
      return;
    }
    if (generation != _authGeneration || _auth.currentUser?.uid != user.uid) {
      return;
    }

    _eligibleUserId = user.uid;
    await _tokenOwnership.authenticatedUserChanged(user.uid);
    if (_supportsMessagingPlatform) {
      await _requestPermissionAndRegister(user.uid, generation);
    }
  }

  Future<void> _handleUserChangedSafely(User? user) async {
    try {
      await _handleUserChanged(user);
    } catch (error) {
      debugPrint('Notification setup failed: $error');
    }
  }

  Future<void> _requestPermissionAndRegister(
    String userId,
    int generation,
  ) async {
    if (kIsWeb && _webVapidKey.isEmpty) {
      debugPrint(
        'Web push is disabled: provide FCM_WEB_VAPID_KEY at build time.',
      );
      return;
    }

    final settings = await _messaging.requestPermission();
    if (settings.authorizationStatus != AuthorizationStatus.authorized &&
        settings.authorizationStatus != AuthorizationStatus.provisional) {
      debugPrint('Push notifications are not authorized on this device.');
      return;
    }
    if (!_isCurrentUser(userId, generation)) return;
    final token = await _messaging.getToken(
      vapidKey: kIsWeb ? _webVapidKey : null,
    );
    if (token == null || token.isEmpty) {
      debugPrint('Firebase Messaging did not provide a device token.');
      return;
    }
    await _registerCurrentToken(token, userId, generation);
  }

  Future<void> _handleTokenRefresh(String token) async {
    final userId = _eligibleUserId;
    if (userId == null || token.isEmpty) return;
    await _registerCurrentToken(token, userId, _authGeneration);
  }

  Future<void> _registerCurrentToken(
    String token,
    String userId,
    int generation,
  ) async {
    if (!_isCurrentUser(userId, generation)) return;
    try {
      await _tokenOwnership.authenticatedUserChanged(userId, token: token);
    } catch (error) {
      debugPrint('Device-token registration failed: $error');
    }
  }

  bool _isCurrentUser(String userId, int generation) {
    return generation == _authGeneration &&
        _eligibleUserId == userId &&
        _auth.currentUser?.uid == userId;
  }

  Future<void> _registerToken(String uid, String token) async {
    final callable = _functions.httpsCallable('registerDeviceToken');
    await callable.call({
      'expectedUid': uid,
      'token': token,
      'platform': _platformName,
    });
  }

  Future<void> _unregisterToken(String uid, String token) async {
    final callable = _functions.httpsCallable('unregisterDeviceToken');
    await callable.call({'expectedUid': uid, 'token': token});
  }

  bool get _supportsMessagingPlatform {
    if (kIsWeb) return true;
    return defaultTargetPlatform == TargetPlatform.android ||
        defaultTargetPlatform == TargetPlatform.iOS;
  }

  String get _platformName {
    if (kIsWeb) return 'web';
    switch (defaultTargetPlatform) {
      case TargetPlatform.android:
        return 'android';
      case TargetPlatform.iOS:
        return 'ios';
      default:
        throw UnsupportedError(
          'Push notifications are unsupported on this platform.',
        );
    }
  }
}
