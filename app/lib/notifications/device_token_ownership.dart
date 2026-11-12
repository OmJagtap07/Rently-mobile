import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

@immutable
class DeviceTokenOwner {
  const DeviceTokenOwner({
    required this.uid,
    required this.token,
    this.registered = true,
  });

  final String uid;
  final String token;
  final bool registered;

  Map<String, Object> toJson() => {
    'uid': uid,
    'token': token,
    'registered': registered,
  };

  static DeviceTokenOwner? fromJson(Object? value) {
    if (value is! Map<String, dynamic>) return null;
    final uid = value['uid'];
    final token = value['token'];
    if (uid is! String || uid.isEmpty || token is! String || token.isEmpty) {
      return null;
    }
    return DeviceTokenOwner(
      uid: uid,
      token: token,
      registered: value['registered'] is bool
          ? value['registered'] as bool
          : true,
    );
  }
}

@immutable
class DeviceTokenOwnershipState {
  const DeviceTokenOwnershipState({
    this.owner,
    this.pendingUnregistrations = const [],
  });

  final DeviceTokenOwner? owner;
  final List<DeviceTokenOwner> pendingUnregistrations;

  factory DeviceTokenOwnershipState.decode(String? value) {
    if (value == null || value.isEmpty) {
      return const DeviceTokenOwnershipState();
    }
    final decoded = jsonDecode(value);
    if (decoded is! Map<String, dynamic>) {
      throw const FormatException('Invalid device-token ownership state.');
    }
    final pending = decoded['pendingUnregistrations'];
    return DeviceTokenOwnershipState(
      owner: DeviceTokenOwner.fromJson(decoded['owner']),
      pendingUnregistrations: pending is List
          ? pending
                .map(DeviceTokenOwner.fromJson)
                .whereType<DeviceTokenOwner>()
                .toList()
          : const [],
    );
  }

  String encode() => jsonEncode({
    if (owner != null) 'owner': owner!.toJson(),
    'pendingUnregistrations': pendingUnregistrations
        .map((entry) => entry.toJson())
        .toList(),
  });

  DeviceTokenOwnershipState copyWith({
    DeviceTokenOwner? owner,
    bool clearOwner = false,
    List<DeviceTokenOwner>? pendingUnregistrations,
  }) {
    return DeviceTokenOwnershipState(
      owner: clearOwner ? null : owner ?? this.owner,
      pendingUnregistrations:
          pendingUnregistrations ?? this.pendingUnregistrations,
    );
  }
}

abstract interface class DeviceTokenOwnershipStore {
  Future<DeviceTokenOwnershipState> read();
  Future<void> write(DeviceTokenOwnershipState state);
}

class SecureDeviceTokenOwnershipStore implements DeviceTokenOwnershipStore {
  SecureDeviceTokenOwnershipStore({FlutterSecureStorage? storage})
    : _storage = storage ?? const FlutterSecureStorage();

  static const _storageKey = 'rently.device_token_ownership.v1';
  final FlutterSecureStorage _storage;

  @override
  Future<DeviceTokenOwnershipState> read() async {
    return DeviceTokenOwnershipState.decode(
      await _storage.read(key: _storageKey),
    );
  }

  @override
  Future<void> write(DeviceTokenOwnershipState state) {
    return _storage.write(key: _storageKey, value: state.encode());
  }
}

typedef DeviceTokenOwnerAction = Future<void> Function(
  String uid,
  String token,
);

class DeviceTokenOwnershipManager {
  DeviceTokenOwnershipManager({
    required this._store,
    required this._register,
    required this._unregister,
    required this._authenticatedUid,
    this.cleanupTimeout = const Duration(seconds: 4),
  });

  final DeviceTokenOwnershipStore _store;
  final DeviceTokenOwnerAction _register;
  final DeviceTokenOwnerAction _unregister;
  final String? Function() _authenticatedUid;
  final Duration cleanupTimeout;
  Future<void> _queue = Future<void>.value();

  Future<bool> authenticatedUserChanged(String? uid, {String? token}) {
    return _serialize(() async {
      var state = await _store.read();
      if (uid == null) {
        state = _moveOwnerToPending(state);
        await _store.write(state);
        return false;
      }

      await _retryPendingForUser(uid, state);
      state = await _store.read();
      if (state.owner != null && state.owner!.uid != uid) {
        state = _moveOwnerToPending(state);
        await _store.write(state);
      }
      if (token == null || token.isEmpty) return false;

      final tokenOwnedByAnotherUser = state.pendingUnregistrations.any(
        (pending) => pending.token == token && pending.uid != uid,
      );
      if (tokenOwnedByAnotherUser) {
        debugPrint(
          'Device token registration deferred until its previous owner '
          'can be safely unregistered.',
        );
        return false;
      }
      if (state.owner?.uid == uid &&
          state.owner?.token == token &&
          state.owner?.registered == true) {
        return true;
      }

      final previousOwner = state.owner;
      final nextOwner = DeviceTokenOwner(
        uid: uid,
        token: token,
        registered: false,
      );
      state = state.copyWith(owner: nextOwner);
      if (previousOwner != null &&
          previousOwner.uid == uid &&
          previousOwner.token != token) {
        state = _addPending(state, previousOwner);
      }
      await _store.write(state);
      await _register(uid, token);
      state = state.copyWith(
        owner: DeviceTokenOwner(uid: uid, token: token),
      );
      await _store.write(state);
      await _retryPendingForUser(uid, state);
      return true;
    });
  }

  Future<void> prepareForSignOut(String uid) {
    return _serialize(() async {
      var state = await _store.read();
      if (state.owner?.uid == uid) {
        state = _moveOwnerToPending(state);
        await _store.write(state);
      }
      await _retryPendingForUser(uid, state);
    });
  }

  DeviceTokenOwnershipState _moveOwnerToPending(
    DeviceTokenOwnershipState state,
  ) {
    final owner = state.owner;
    return owner == null
        ? state
        : _addPending(state.copyWith(clearOwner: true), owner);
  }

  DeviceTokenOwnershipState _addPending(
    DeviceTokenOwnershipState state,
    DeviceTokenOwner owner,
  ) {
    if (state.pendingUnregistrations.any(
      (pending) => pending.uid == owner.uid && pending.token == owner.token,
    )) {
      return state;
    }
    return state.copyWith(
      pendingUnregistrations: [...state.pendingUnregistrations, owner],
    );
  }

  Future<void> _retryPendingForUser(
    String uid,
    DeviceTokenOwnershipState state,
  ) async {
    if (_authenticatedUid() != uid) return;
    for (final pending
        in state.pendingUnregistrations
            .where((entry) => entry.uid == uid)
            .toList()) {
      if (_authenticatedUid() != uid) return;
      try {
        await _unregister(uid, pending.token).timeout(cleanupTimeout);
        state = state.copyWith(
          pendingUnregistrations: state.pendingUnregistrations
              .where(
                (entry) =>
                    entry.uid != pending.uid || entry.token != pending.token,
              )
              .toList(),
        );
        await _store.write(state);
      } catch (error) {
        debugPrint('Device-token cleanup deferred for retry: $error');
      }
    }
  }

  Future<T> _serialize<T>(Future<T> Function() operation) {
    final completer = Completer<T>();
    _queue = _queue
        .then((_) async {
          try {
            completer.complete(await operation());
          } catch (error, stackTrace) {
            completer.completeError(error, stackTrace);
          }
        })
        .catchError((Object error) {
          debugPrint('Device-token ownership queue failed: $error');
        });
    return completer.future;
  }
}
