import 'dart:async';

import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';

enum NotificationMessageKind { foreground, opened }

@immutable
class NotificationMessageEvent {
  const NotificationMessageEvent({
    required this.notificationId,
    required this.kind,
    required this.data,
    this.title,
    this.body,
  });

  final String notificationId;
  final NotificationMessageKind kind;
  final Map<String, dynamic> data;
  final String? title;
  final String? body;
}

class NotificationMessageCoordinator {
  final _foregroundController =
      StreamController<NotificationMessageEvent>.broadcast();
  final _openedController =
      StreamController<NotificationMessageEvent>.broadcast();
  final Set<String> _foregroundIds = {};
  final Set<String> _openedIds = {};

  Stream<NotificationMessageEvent> get foregroundEvents =>
      _foregroundController.stream;
  Stream<NotificationMessageEvent> get openedEvents => _openedController.stream;

  void handleForeground(RemoteMessage message) {
    final event = _eventFor(message, NotificationMessageKind.foreground);
    if (event == null || !_remember(_foregroundIds, event.notificationId)) {
      return;
    }
    _foregroundController.add(event);
  }

  void handleOpened(RemoteMessage message) {
    final event = _eventFor(message, NotificationMessageKind.opened);
    if (event == null || !_remember(_openedIds, event.notificationId)) return;
    _openedController.add(event);
  }

  NotificationMessageEvent? _eventFor(
    RemoteMessage message,
    NotificationMessageKind kind,
  ) {
    final notificationId = message.data['notificationId'];
    if (notificationId is! String || notificationId.isEmpty) {
      debugPrint('Ignoring notification without a stable notificationId.');
      return null;
    }
    return NotificationMessageEvent(
      notificationId: notificationId,
      kind: kind,
      data: Map.unmodifiable(message.data),
      title: message.notification?.title,
      body: message.notification?.body,
    );
  }

  bool _remember(Set<String> ids, String id) {
    if (!ids.add(id)) return false;
    if (ids.length > 256) ids.remove(ids.first);
    return true;
  }

  Future<void> dispose() async {
    await _foregroundController.close();
    await _openedController.close();
  }
}

class NotificationSubscriptionLifecycle {
  List<StreamSubscription<dynamic>>? _subscriptions;

  bool get isStarted => _subscriptions != null;

  void start<TAuth>({
    required Stream<TAuth> authChanges,
    required Stream<String> tokenRefreshes,
    required Stream<RemoteMessage> foregroundMessages,
    required Stream<RemoteMessage> openedMessages,
    required void Function(TAuth value) onAuthChanged,
    required void Function(String token) onTokenRefresh,
    required void Function(RemoteMessage message) onForegroundMessage,
    required void Function(RemoteMessage message) onOpenedMessage,
    required void Function(Object error, StackTrace stackTrace) onError,
  }) {
    if (isStarted) return;
    _subscriptions = [
      authChanges.listen(onAuthChanged, onError: onError),
      tokenRefreshes.listen(onTokenRefresh, onError: onError),
      foregroundMessages.listen(onForegroundMessage, onError: onError),
      openedMessages.listen(onOpenedMessage, onError: onError),
    ];
  }

  Future<void> dispose() async {
    final subscriptions = _subscriptions;
    _subscriptions = null;
    if (subscriptions == null) return;
    await Future.wait(
      subscriptions.map((subscription) => subscription.cancel()),
    );
  }
}
