import 'dart:async';

import 'package:app/main.dart';
import 'package:app/notifications/device_token_ownership.dart';
import 'package:app/notifications/notification_message_handler.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter_test/flutter_test.dart';

class _MemoryOwnershipStore implements DeviceTokenOwnershipStore {
  DeviceTokenOwnershipState state = const DeviceTokenOwnershipState();

  @override
  Future<DeviceTokenOwnershipState> read() async => state;

  @override
  Future<void> write(DeviceTokenOwnershipState value) async {
    state = value;
  }
}

RemoteMessage _message(String notificationId) => RemoteMessage(
  data: {'notificationId': notificationId, 'type': 'rent_due'},
  notification: const RemoteNotification(
    title: 'Rent due',
    body: 'A bill is due',
  ),
);

void main() {
  group('DeviceTokenOwnershipManager', () {
    test('removes the outgoing user token before sign-out', () async {
      final store = _MemoryOwnershipStore();
      var authenticatedUid = 'tenant-a';
      final registered = <String>[];
      final unregistered = <String>[];
      final manager = DeviceTokenOwnershipManager(
        store: store,
        authenticatedUid: () => authenticatedUid,
        register: (uid, token) async => registered.add('$uid:$token'),
        unregister: (uid, token) async => unregistered.add('$uid:$token'),
      );

      await manager.authenticatedUserChanged(
        authenticatedUid,
        token: 'shared-device-token',
      );
      await manager.prepareForSignOut(authenticatedUid);

      expect(registered, ['tenant-a:shared-device-token']);
      expect(unregistered, ['tenant-a:shared-device-token']);
      expect(store.state.owner, isNull);
      expect(store.state.pendingUnregistrations, isEmpty);
    });

    test('retains failed cleanup for a later authenticated retry', () async {
      final store = _MemoryOwnershipStore();
      var authenticatedUid = 'tenant-a';
      var failCleanup = true;
      final registered = <String>[];
      final manager = DeviceTokenOwnershipManager(
        store: store,
        authenticatedUid: () => authenticatedUid,
        register: (uid, token) async => registered.add('$uid:$token'),
        unregister: (uid, token) async {
          if (failCleanup) throw StateError('offline');
        },
      );

      await manager.authenticatedUserChanged(
        authenticatedUid,
        token: 'shared-device-token',
      );
      await manager.prepareForSignOut(authenticatedUid);
      expect(store.state.pendingUnregistrations, hasLength(1));

      authenticatedUid = 'tenant-b';
      final registeredForB = await manager.authenticatedUserChanged(
        authenticatedUid,
        token: 'shared-device-token',
      );
      expect(registeredForB, isFalse);
      expect(registered, ['tenant-a:shared-device-token']);

      authenticatedUid = 'tenant-a';
      failCleanup = false;
      await manager.authenticatedUserChanged(
        authenticatedUid,
        token: 'shared-device-token',
      );
      expect(store.state.pendingUnregistrations, isEmpty);
      expect(registered, [
        'tenant-a:shared-device-token',
        'tenant-a:shared-device-token',
      ]);
    });

    test('does not transfer a reused token to a different account', () async {
      final store = _MemoryOwnershipStore();
      var authenticatedUid = 'tenant-a';
      final registered = <String>[];
      final unregistered = <String>[];
      final manager = DeviceTokenOwnershipManager(
        store: store,
        authenticatedUid: () => authenticatedUid,
        register: (uid, token) async => registered.add('$uid:$token'),
        unregister: (uid, token) async => unregistered.add('$uid:$token'),
      );

      await manager.authenticatedUserChanged(
        authenticatedUid,
        token: 'shared-device-token',
      );
      authenticatedUid = 'tenant-b';
      final switched = await manager.authenticatedUserChanged(
        authenticatedUid,
        token: 'shared-device-token',
      );

      expect(switched, isFalse);
      expect(registered, ['tenant-a:shared-device-token']);
      expect(unregistered, isEmpty);
      expect(store.state.pendingUnregistrations.single.uid, 'tenant-a');

      authenticatedUid = 'tenant-a';
      await manager.prepareForSignOut(authenticatedUid);
      authenticatedUid = 'tenant-b';
      await manager.authenticatedUserChanged(
        authenticatedUid,
        token: 'shared-device-token',
      );
      expect(unregistered, ['tenant-a:shared-device-token']);
      expect(registered, [
        'tenant-a:shared-device-token',
        'tenant-b:shared-device-token',
      ]);
    });
  });

  group('NotificationSubscriptionLifecycle', () {
    test(
      'keeps auth handling across sign-out and avoids duplicate listeners',
      () async {
        final auth = StreamController<String?>.broadcast();
        final refresh = StreamController<String>.broadcast();
        final foreground = StreamController<RemoteMessage>.broadcast();
        final opened = StreamController<RemoteMessage>.broadcast();
        final lifecycle = NotificationSubscriptionLifecycle();
        final authEvents = <String?>[];
        var refreshCount = 0;
        var foregroundCount = 0;
        var openedCount = 0;

        void start() {
          lifecycle.start<String?>(
            authChanges: auth.stream,
            tokenRefreshes: refresh.stream,
            foregroundMessages: foreground.stream,
            openedMessages: opened.stream,
            onAuthChanged: authEvents.add,
            onTokenRefresh: (_) => refreshCount++,
            onForegroundMessage: (_) => foregroundCount++,
            onOpenedMessage: (_) => openedCount++,
            onError: (error, stackTrace) {},
          );
        }

        start();
        start();
        auth
          ..add('tenant-a')
          ..add(null)
          ..add('tenant-b');
        refresh.add('refreshed-token');
        foreground.add(_message('foreground-1'));
        opened.add(_message('opened-1'));
        await Future<void>.delayed(Duration.zero);

        expect(authEvents, ['tenant-a', null, 'tenant-b']);
        expect(refreshCount, 1);
        expect(foregroundCount, 1);
        expect(openedCount, 1);

        await lifecycle.dispose();
        start();
        auth.add('tenant-c');
        await Future<void>.delayed(Duration.zero);
        expect(authEvents, ['tenant-a', null, 'tenant-b', 'tenant-c']);

        await lifecycle.dispose();
        await auth.close();
        await refresh.close();
        await foreground.close();
        await opened.close();
      },
    );
  });

  group('NotificationMessageCoordinator', () {
    test('deduplicates foreground entries by stable notification ID', () async {
      final coordinator = NotificationMessageCoordinator();
      final events = <NotificationMessageEvent>[];
      final subscription = coordinator.foregroundEvents.listen(events.add);

      coordinator
        ..handleForeground(_message('rent-charge-1'))
        ..handleForeground(_message('rent-charge-1'));
      await Future<void>.delayed(Duration.zero);

      expect(events, hasLength(1));
      expect(events.single.notificationId, 'rent-charge-1');
      expect(events.single.title, 'Rent due');

      await subscription.cancel();
      await coordinator.dispose();
    });

    test('handles tap and initial-message events without duplicates', () async {
      final coordinator = NotificationMessageCoordinator();
      final events = <NotificationMessageEvent>[];
      final subscription = coordinator.openedEvents.listen(events.add);

      coordinator
        ..handleOpened(_message('rent-charge-2'))
        ..handleOpened(_message('rent-charge-2'));
      await Future<void>.delayed(Duration.zero);

      expect(events, hasLength(1));
      expect(events.single.kind, NotificationMessageKind.opened);
      expect(events.single.data['notificationId'], 'rent-charge-2');

      await subscription.cancel();
      await coordinator.dispose();
    });
  });

  testWidgets('missing iOS Firebase configuration has a safe setup screen', (
    tester,
  ) async {
    await tester.pumpWidget(
      const FirebaseConfigurationRequiredApp(
        message: 'iOS Firebase is not configured.',
      ),
    );

    expect(find.text('iOS Firebase is not configured.'), findsOneWidget);
    expect(find.textContaining('GoogleService-Info.plist'), findsOneWidget);
    expect(find.textContaining('APNs'), findsOneWidget);
  });
}
