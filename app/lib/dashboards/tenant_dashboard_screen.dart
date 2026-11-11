import 'package:flutter/material.dart';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:cloud_functions/cloud_functions.dart';

import '../auth/auth_service.dart';
import '../services/property_service.dart';

class PendingJoinRequestAvailabilityMessage extends StatelessWidget {
  final Stream<bool> availabilityStream;

  const PendingJoinRequestAvailabilityMessage({
    super.key,
    required this.availabilityStream,
  });

  @override
  Widget build(BuildContext context) {
    return StreamBuilder<bool>(
      stream: availabilityStream,
      builder: (context, snapshot) {
        final message = snapshot.hasError
            ? 'Could not check unit availability. Your request is still pending.'
            : snapshot.data == null
            ? 'Checking unit availability...'
            : snapshot.data!
            ? 'Your request is pending landlord approval. A unit will be '
                  'assigned if your request is accepted.'
            : "All units are currently rented out. Your request is still "
                  "pending. We'll assign you a unit when one becomes available.";
        return Text(message, style: const TextStyle(fontSize: 13));
      },
    );
  }
}

class TenantDashboardScreen extends StatefulWidget {
  const TenantDashboardScreen({super.key});

  @override
  State<TenantDashboardScreen> createState() => _TenantDashboardScreenState();
}

class _TenantDashboardScreenState extends State<TenantDashboardScreen> {
  final PropertyService _propertyService = PropertyService();
  final String? _uid = FirebaseAuth.instance.currentUser?.uid;

  // ───────────────────────── JOIN PROPERTY DIALOG ─────────────────────────

  void _showJoinPropertyDialog() {
    final codeCtrl = TextEditingController();
    final messageCtrl = TextEditingController();
    Map<String, dynamic>? resolvedProperty;
    bool isResolving = false;
    bool isSubmitting = false;
    String? errorText;

    showDialog(
      context: context,
      builder: (dialogCtx) {
        return StatefulBuilder(
          builder: (context, setDialogState) {
            return AlertDialog(
              title: const Text('Join a Property'),
              content: SingleChildScrollView(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    const Text(
                      'Ask your landlord for the 8-character property join code.',
                      style: TextStyle(fontSize: 13, color: Colors.black54),
                    ),
                    const SizedBox(height: 12),
                    Row(
                      children: [
                        Expanded(
                          child: TextField(
                            controller: codeCtrl,
                            textCapitalization: TextCapitalization.characters,
                            decoration: InputDecoration(
                              labelText: 'Join Code',
                              hintText: 'e.g. 8A2B3C4D',
                              border: const OutlineInputBorder(),
                              errorText: errorText,
                            ),
                          ),
                        ),
                        const SizedBox(width: 8),
                        ElevatedButton(
                          onPressed: isResolving
                              ? null
                              : () async {
                                  final code = codeCtrl.text.trim();
                                  if (code.isEmpty) {
                                    setDialogState(
                                      () => errorText = 'Enter code',
                                    );
                                    return;
                                  }
                                  setDialogState(() {
                                    isResolving = true;
                                    errorText = null;
                                  });
                                  try {
                                    final prop = await _propertyService
                                        .resolveJoinCode(code);
                                    setDialogState(() {
                                      resolvedProperty = prop;
                                      isResolving = false;
                                    });
                                  } on FirebaseFunctionsException catch (e) {
                                    setDialogState(() {
                                      isResolving = false;
                                      errorText =
                                          e.message ?? 'Property not found';
                                    });
                                  } catch (e) {
                                    setDialogState(() {
                                      isResolving = false;
                                      errorText = 'Invalid or inactive code';
                                    });
                                  }
                                },
                          child: isResolving
                              ? const SizedBox(
                                  width: 16,
                                  height: 16,
                                  child: CircularProgressIndicator(
                                    strokeWidth: 2,
                                  ),
                                )
                              : const Text('Verify'),
                        ),
                      ],
                    ),
                    if (resolvedProperty != null) ...[
                      const SizedBox(height: 16),
                      Container(
                        padding: const EdgeInsets.all(12),
                        decoration: BoxDecoration(
                          color: Colors.green.shade50,
                          borderRadius: BorderRadius.circular(8),
                          border: Border.all(color: Colors.green.shade300),
                        ),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Row(
                              children: [
                                const Icon(
                                  Icons.check_circle,
                                  color: Colors.green,
                                  size: 18,
                                ),
                                const SizedBox(width: 6),
                                Expanded(
                                  child: Text(
                                    resolvedProperty!['name'] ?? '',
                                    style: const TextStyle(
                                      fontWeight: FontWeight.bold,
                                      fontSize: 16,
                                    ),
                                  ),
                                ),
                              ],
                            ),
                            const SizedBox(height: 4),
                            Text(
                              resolvedProperty!['address'] ?? '',
                              style: TextStyle(
                                color: Colors.grey.shade700,
                                fontSize: 13,
                              ),
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(height: 12),
                      TextField(
                        controller: messageCtrl,
                        decoration: const InputDecoration(
                          labelText: 'Message to Landlord (Optional)',
                          hintText: 'e.g. Inquiring about room 101',
                          border: OutlineInputBorder(),
                        ),
                        maxLines: 2,
                      ),
                    ],
                  ],
                ),
              ),
              actions: [
                TextButton(
                  onPressed: () => Navigator.pop(dialogCtx),
                  child: const Text('Cancel'),
                ),
                if (resolvedProperty != null)
                  ElevatedButton(
                    onPressed: isSubmitting
                        ? null
                        : () async {
                            setDialogState(() => isSubmitting = true);
                            try {
                              await _propertyService.submitJoinRequest(
                                propertyId: resolvedProperty!['propertyId'],
                                message: messageCtrl.text.trim(),
                              );
                              if (!mounted) return;
                              Navigator.pop(dialogCtx);
                              ScaffoldMessenger.of(context).showSnackBar(
                                const SnackBar(
                                  content: Text(
                                    'Join request submitted successfully!',
                                  ),
                                ),
                              );
                            } catch (e) {
                              setDialogState(() => isSubmitting = false);
                              ScaffoldMessenger.of(context).showSnackBar(
                                SnackBar(content: Text('Error: $e')),
                              );
                            }
                          },
                    child: isSubmitting
                        ? const SizedBox(
                            width: 16,
                            height: 16,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Text('Submit Application'),
                  ),
              ],
            );
          },
        );
      },
    );
  }

  // ───────────────────────── ACTIVE TENANCY CARD ─────────────────────────

  Widget _buildActiveTenancyCard(String activeLeaseId) {
    return FutureBuilder<DocumentSnapshot<Map<String, dynamic>>>(
      future: _propertyService.getLease(activeLeaseId),
      builder: (context, leaseSnap) {
        if (leaseSnap.connectionState == ConnectionState.waiting) {
          return const Center(child: CircularProgressIndicator());
        }

        final leaseData = leaseSnap.data?.data();
        if (leaseData == null || leaseData['status'] != 'active') {
          return const Center(child: Text('Lease details unavailable.'));
        }

        final propertyId = leaseData['propertyId'] as String? ?? '';
        final unitId = leaseData['unitId'] as String? ?? '';
        final joiningDate = leaseData['joiningDate'] ?? '';
        final currentBaseRentPaise = (leaseData['currentBaseRent'] ?? 0) as int;
        final currentBaseRentRupees = (currentBaseRentPaise / 100)
            .toStringAsFixed(0);

        return FutureBuilder<List<DocumentSnapshot<Map<String, dynamic>>>>(
          future: Future.wait([
            _propertyService.getProperty(propertyId),
            _propertyService.getUnit(unitId),
          ]),
          builder: (context, detailsSnap) {
            if (detailsSnap.connectionState == ConnectionState.waiting) {
              return const Center(child: CircularProgressIndicator());
            }

            final propData = detailsSnap.data?[0].data();
            final unitData = detailsSnap.data?[1].data();

            final propName = propData?['name'] ?? 'Your Property';
            final propAddress = propData?['address'] ?? '';
            final roomNumber = unitData?['roomNumber'] ?? 'Assigned';

            return SingleChildScrollView(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Card(
                    elevation: 3,
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(16),
                    ),
                    child: Padding(
                      padding: const EdgeInsets.all(20),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Row(
                            mainAxisAlignment: MainAxisAlignment.spaceBetween,
                            children: [
                              Expanded(
                                child: Text(
                                  propName,
                                  style: Theme.of(context)
                                      .textTheme
                                      .headlineSmall
                                      ?.copyWith(fontWeight: FontWeight.bold),
                                ),
                              ),
                              Container(
                                padding: const EdgeInsets.symmetric(
                                  horizontal: 10,
                                  vertical: 4,
                                ),
                                decoration: BoxDecoration(
                                  color: Colors.green.shade100,
                                  borderRadius: BorderRadius.circular(8),
                                ),
                                child: const Text(
                                  'Active Lease',
                                  style: TextStyle(
                                    color: Colors.green,
                                    fontWeight: FontWeight.bold,
                                  ),
                                ),
                              ),
                            ],
                          ),
                          const SizedBox(height: 6),
                          Row(
                            children: [
                              const Icon(
                                Icons.location_on,
                                size: 16,
                                color: Colors.grey,
                              ),
                              const SizedBox(width: 4),
                              Expanded(
                                child: Text(
                                  propAddress,
                                  style: TextStyle(
                                    color: Colors.grey.shade700,
                                    fontSize: 14,
                                  ),
                                ),
                              ),
                            ],
                          ),
                          const Divider(height: 32),
                          Row(
                            mainAxisAlignment: MainAxisAlignment.spaceAround,
                            children: [
                              Column(
                                children: [
                                  const Text(
                                    'Room',
                                    style: TextStyle(color: Colors.grey),
                                  ),
                                  const SizedBox(height: 4),
                                  Text(
                                    roomNumber,
                                    style: const TextStyle(
                                      fontSize: 20,
                                      fontWeight: FontWeight.bold,
                                    ),
                                  ),
                                ],
                              ),
                              Column(
                                children: [
                                  const Text(
                                    'Monthly Rent',
                                    style: TextStyle(color: Colors.grey),
                                  ),
                                  const SizedBox(height: 4),
                                  Text(
                                    '₹$currentBaseRentRupees',
                                    style: const TextStyle(
                                      fontSize: 20,
                                      fontWeight: FontWeight.bold,
                                      color: Colors.blue,
                                    ),
                                  ),
                                ],
                              ),
                              Column(
                                children: [
                                  const Text(
                                    'Joining Date',
                                    style: TextStyle(color: Colors.grey),
                                  ),
                                  const SizedBox(height: 4),
                                  Text(
                                    joiningDate,
                                    style: const TextStyle(
                                      fontSize: 16,
                                      fontWeight: FontWeight.w600,
                                    ),
                                  ),
                                ],
                              ),
                            ],
                          ),
                        ],
                      ),
                    ),
                  ),
                ],
              ),
            );
          },
        );
      },
    );
  }

  // ───────────────────────── NO ACTIVE TENANCY VIEW ─────────────────────────

  Widget _buildNoTenancyView() {
    return SingleChildScrollView(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // Join Banner Card
          Card(
            color: Theme.of(context).colorScheme.primaryContainer
                .withOpacity(0.5),
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(16),
            ),
            child: Padding(
              padding: const EdgeInsets.all(20),
              child: Column(
                children: [
                  const Icon(
                    Icons.home_work_outlined,
                    size: 56,
                    color: Colors.blueAccent,
                  ),
                  const SizedBox(height: 12),
                  const Text(
                    'No Active Tenancy',
                    style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold),
                  ),
                  const SizedBox(height: 6),
                  const Text(
                    'Have a property join code from your landlord? Join now to view your room, bills, and payment records.',
                    textAlign: TextAlign.center,
                    style: TextStyle(fontSize: 13, color: Colors.black87),
                  ),
                  const SizedBox(height: 16),
                  ElevatedButton.icon(
                    style: ElevatedButton.styleFrom(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 24,
                        vertical: 12,
                      ),
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(10),
                      ),
                    ),
                    icon: const Icon(Icons.vpn_key),
                    label: const Text(
                      'Enter Join Code',
                      style: TextStyle(fontSize: 15),
                    ),
                    onPressed: _showJoinPropertyDialog,
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 24),
          const Text(
            'Your Submitted Applications',
            style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
          ),
          const SizedBox(height: 12),
          // Applications Stream
          StreamBuilder<QuerySnapshot<Map<String, dynamic>>>(
            stream: _propertyService.getTenantJoinRequestsStream(),
            builder: (context, snapshot) {
              if (snapshot.connectionState == ConnectionState.waiting) {
                return const Center(child: CircularProgressIndicator());
              }

              final requests = snapshot.data?.docs ?? [];
              if (requests.isEmpty) {
                return Center(
                  child: Padding(
                    padding: const EdgeInsets.all(24.0),
                    child: Text(
                      'You have not submitted any join requests yet.',
                      style: TextStyle(color: Colors.grey.shade600),
                    ),
                  ),
                );
              }

              return ListView.separated(
                shrinkWrap: true,
                physics: const NeverScrollableScrollPhysics(),
                itemCount: requests.length,
                separatorBuilder: (_, __) => const SizedBox(height: 8),
                itemBuilder: (context, index) {
                  final data = requests[index].data();
                  final propertyName = data['propertyName'] ?? 'Property';
                  final status = data['status'] ?? 'pending';
                  final propertyId = data['propertyId'] as String?;

                  Color badgeColor;
                  Color textColor;
                  String label;

                  if (status == 'accepted') {
                    badgeColor = Colors.green.shade100;
                    textColor = Colors.green.shade900;
                    label = 'Accepted';
                  } else if (status == 'rejected') {
                    badgeColor = Colors.red.shade100;
                    textColor = Colors.red.shade900;
                    label = 'Declined';
                  } else {
                    badgeColor = Colors.amber.shade100;
                    textColor = Colors.amber.shade900;
                    label = 'Pending Review';
                  }

                  return Card(
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(10),
                    ),
                    child: ListTile(
                      leading: const CircleAvatar(child: Icon(Icons.apartment)),
                      title: Text(
                        propertyName,
                        style: const TextStyle(fontWeight: FontWeight.bold),
                      ),
                      subtitle: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text('Status: $label'),
                          if (status == 'pending') ...[
                            const SizedBox(height: 4),
                            if (propertyId != null && propertyId.isNotEmpty)
                              PendingJoinRequestAvailabilityMessage(
                                availabilityStream: _propertyService
                                    .watchPendingRequestAvailability(
                                      propertyId,
                                    ),
                              )
                            else
                              const Text(
                                'Could not check unit availability. '
                                'Your request is still pending.',
                                style: TextStyle(fontSize: 13),
                              ),
                          ],
                        ],
                      ),
                      trailing: Container(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 10,
                          vertical: 4,
                        ),
                        decoration: BoxDecoration(
                          color: badgeColor,
                          borderRadius: BorderRadius.circular(6),
                        ),
                        child: Text(
                          label,
                          style: TextStyle(
                            fontSize: 12,
                            fontWeight: FontWeight.bold,
                            color: textColor,
                          ),
                        ),
                      ),
                    ),
                  );
                },
              );
            },
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (_uid == null) {
      return const Scaffold(body: Center(child: Text('Not authenticated')));
    }

    return Scaffold(
      appBar: AppBar(
        title: const Text('Tenant Dashboard'),
        actions: [
          IconButton(
            icon: const Icon(Icons.logout),
            tooltip: 'Sign Out',
            onPressed: () => AuthService().signOut(),
          ),
        ],
      ),
      body: StreamBuilder<DocumentSnapshot<Map<String, dynamic>>>(
        stream: FirebaseFirestore.instance
            .collection('users')
            .doc(_uid)
            .snapshots(),
        builder: (context, userSnap) {
          if (userSnap.connectionState == ConnectionState.waiting) {
            return const Center(child: CircularProgressIndicator());
          }

          final userData = userSnap.data?.data();
          final activeLeaseId = userData?['activeLeaseId'] as String?;

          if (activeLeaseId != null && activeLeaseId.isNotEmpty) {
            return _buildActiveTenancyCard(activeLeaseId);
          }

          return _buildNoTenancyView();
        },
      ),
    );
  }
}
