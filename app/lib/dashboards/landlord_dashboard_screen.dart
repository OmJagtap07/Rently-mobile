import 'package:flutter/material.dart';
import 'package:cloud_firestore/cloud_firestore.dart';

import '../auth/auth_service.dart';
import '../services/property_service.dart';
import '../services/property_payment_details.dart';
import '../services/landlord_payment_review_repository.dart';
import 'landlord/landlord_payment_review_screen.dart';
import 'landlord/monthly_billing_screen.dart';
import 'landlord/property_details_screen.dart';

class NoAvailableUnitsNotice extends StatelessWidget {
  const NoAvailableUnitsNotice({super.key});

  @override
  Widget build(BuildContext context) {
    return const Padding(
      padding: EdgeInsets.symmetric(vertical: 8.0),
      child: Text(
        'No units are currently available. This request will remain pending. '
        'You can accept it once a unit becomes vacant.',
        style: TextStyle(color: Colors.red),
      ),
    );
  }
}

class LandlordDashboardScreen extends StatefulWidget {
  const LandlordDashboardScreen({super.key});

  @override
  State<LandlordDashboardScreen> createState() =>
      _LandlordDashboardScreenState();
}

class _LandlordDashboardScreenState extends State<LandlordDashboardScreen> {
  int _currentIndex = 0;
  final PropertyService _propertyService = PropertyService();
  final LandlordPaymentReviewRepository _paymentReviewRepository =
      FirebaseLandlordPaymentReviewRepository();

  // ───────────────────────── ADD PROPERTY DIALOG ─────────────────────────

  void _showAddPropertyDialog() {
    final nameCtrl = TextEditingController();
    final addressCtrl = TextEditingController();
    final mapsCtrl = TextEditingController();
    final upiIdCtrl = TextEditingController();
    final upiQrImageUrlCtrl = TextEditingController();
    final upiDisplayNameCtrl = TextEditingController();
    final formKey = GlobalKey<FormState>();
    bool isSaving = false;

    showDialog(
      context: context,
      builder: (dialogCtx) {
        return StatefulBuilder(
          builder: (context, setDialogState) {
            return AlertDialog(
              title: const Text('Add New Property'),
              content: SingleChildScrollView(
                child: Form(
                  key: formKey,
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      TextFormField(
                        controller: nameCtrl,
                        decoration: const InputDecoration(
                          labelText: 'Property Name *',
                          hintText: 'e.g. Green Heights',
                          border: OutlineInputBorder(),
                        ),
                        validator: (val) => val == null || val.trim().isEmpty
                            ? 'Enter property name'
                            : null,
                      ),
                      const SizedBox(height: 12),
                      TextFormField(
                        controller: addressCtrl,
                        decoration: const InputDecoration(
                          labelText: 'Address *',
                          hintText: 'e.g. 124 Main Street, City',
                          border: OutlineInputBorder(),
                        ),
                        maxLines: 2,
                        validator: (val) => val == null || val.trim().isEmpty
                            ? 'Enter address'
                            : null,
                      ),
                      const SizedBox(height: 12),
                      TextFormField(
                        controller: mapsCtrl,
                        decoration: const InputDecoration(
                          labelText: 'Google Maps Link (Optional)',
                          hintText: 'https://maps.google.com/?q=...',
                          border: OutlineInputBorder(),
                        ),
                      ),
                      const SizedBox(height: 12),
                      TextFormField(
                        controller: upiIdCtrl,
                        keyboardType: TextInputType.emailAddress,
                        decoration: const InputDecoration(
                          labelText: 'Property UPI ID *',
                          hintText: 'name@bank',
                          border: OutlineInputBorder(),
                        ),
                        validator: validateUpiId,
                      ),
                      const SizedBox(height: 12),
                      TextFormField(
                        controller: upiQrImageUrlCtrl,
                        keyboardType: TextInputType.url,
                        decoration: const InputDecoration(
                          labelText: 'UPI QR Image HTTPS URL *',
                          hintText: 'https://...',
                          border: OutlineInputBorder(),
                        ),
                        validator: validateUpiQrImageUrl,
                      ),
                      const SizedBox(height: 12),
                      TextFormField(
                        controller: upiDisplayNameCtrl,
                        textCapitalization: TextCapitalization.words,
                        decoration: const InputDecoration(
                          labelText: 'UPI Recipient Display Name *',
                          border: OutlineInputBorder(),
                        ),
                        validator: validateUpiDisplayName,
                      ),
                    ],
                  ),
                ),
              ),
              actions: [
                TextButton(
                  onPressed: () => Navigator.pop(dialogCtx),
                  child: const Text('Cancel'),
                ),
                ElevatedButton(
                  onPressed: isSaving
                      ? null
                      : () async {
                          if (!formKey.currentState!.validate()) return;
                          setDialogState(() => isSaving = true);
                          try {
                            await _propertyService.createProperty(
                              name: nameCtrl.text.trim(),
                              address: addressCtrl.text.trim(),
                              upiId: upiIdCtrl.text.trim(),
                              upiQrImageUrl: upiQrImageUrlCtrl.text.trim(),
                              upiDisplayName: upiDisplayNameCtrl.text.trim(),
                              googleMapsLink: mapsCtrl.text.trim(),
                            );
                            if (!mounted || !dialogCtx.mounted) return;
                            Navigator.pop(dialogCtx);
                            ScaffoldMessenger.of(context).showSnackBar(
                              const SnackBar(
                                content: Text('Property created successfully!'),
                              ),
                            );
                          } catch (e) {
                            if (!mounted || !dialogCtx.mounted) return;
                            setDialogState(() => isSaving = false);
                            ScaffoldMessenger.of(context).showSnackBar(
                              SnackBar(
                                content: Text('Error creating property: $e'),
                              ),
                            );
                          }
                        },
                  child: isSaving
                      ? const SizedBox(
                          width: 18,
                          height: 18,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Text('Create'),
                ),
              ],
            );
          },
        );
      },
    );
  }

  // ───────────────────────── ACCEPT REQUEST DIALOG ─────────────────────────

  void _showAcceptDialog({
    required String joinRequestId,
    required String propertyId,
    required String applicantName,
  }) {
    String? selectedUnitId;
    DateTime joiningDate = DateTime.now();
    bool isSubmitting = false;

    showDialog(
      context: context,
      builder: (dialogCtx) {
        return StatefulBuilder(
          builder: (context, setDialogState) {
            return AlertDialog(
              title: Text('Accept $applicantName'),
              content: FutureBuilder<QuerySnapshot<Map<String, dynamic>>>(
                future: FirebaseFirestore.instance
                    .collection('units')
                    .where('landlordId', isEqualTo: _propertyService.currentUid)
                    .where('propertyId', isEqualTo: propertyId)
                    .where('status', isEqualTo: 'vacant')
                    .get(),
                builder: (context, snapshot) {
                  if (snapshot.connectionState == ConnectionState.waiting) {
                    return const SizedBox(
                      height: 100,
                      child: Center(child: CircularProgressIndicator()),
                    );
                  }

                  final vacantUnits = snapshot.data?.docs ?? [];
                  if (vacantUnits.isEmpty) {
                    return const NoAvailableUnitsNotice();
                  }

                  return Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text(
                        'Select Room to Assign:',
                        style: TextStyle(fontWeight: FontWeight.w600),
                      ),
                      const SizedBox(height: 8),
                      DropdownButtonFormField<String>(
                        value: selectedUnitId,
                        decoration: const InputDecoration(
                          border: OutlineInputBorder(),
                        ),
                        hint: const Text('Choose vacant room'),
                        items: vacantUnits.map((doc) {
                          final roomNo = doc.data()['roomNumber'] ?? 'N/A';
                          final rentRupees =
                              ((doc.data()['baseRent'] ?? 0) / 100)
                                  .toStringAsFixed(0);
                          return DropdownMenuItem(
                            value: doc.id,
                            child: Text('Room $roomNo (₹$rentRupees/mo)'),
                          );
                        }).toList(),
                        onChanged: (val) =>
                            setDialogState(() => selectedUnitId = val),
                      ),
                      const SizedBox(height: 16),
                      const Text(
                        'Joining Date:',
                        style: TextStyle(fontWeight: FontWeight.w600),
                      ),
                      const SizedBox(height: 4),
                      Row(
                        children: [
                          Text(
                            '${joiningDate.year}-${joiningDate.month.toString().padLeft(2, '0')}-${joiningDate.day.toString().padLeft(2, '0')}',
                            style: const TextStyle(
                              fontSize: 16,
                              fontWeight: FontWeight.w500,
                            ),
                          ),
                          const Spacer(),
                          TextButton(
                            onPressed: () async {
                              final picked = await showDatePicker(
                                context: context,
                                initialDate: joiningDate,
                                firstDate: DateTime(2020),
                                lastDate: DateTime(2035),
                              );
                              if (picked != null) {
                                setDialogState(() => joiningDate = picked);
                              }
                            },
                            child: const Text('Change'),
                          ),
                        ],
                      ),
                    ],
                  );
                },
              ),
              actions: [
                TextButton(
                  onPressed: () => Navigator.pop(dialogCtx),
                  child: const Text('Cancel'),
                ),
                ElevatedButton(
                  onPressed: (selectedUnitId == null || isSubmitting)
                      ? null
                      : () async {
                          setDialogState(() => isSubmitting = true);
                          final dateStr =
                              '${joiningDate.year}-${joiningDate.month.toString().padLeft(2, '0')}-${joiningDate.day.toString().padLeft(2, '0')}';
                          try {
                            await _propertyService.acceptJoinRequest(
                              joinRequestId: joinRequestId,
                              unitId: selectedUnitId!,
                              joiningDate: dateStr,
                            );
                            if (!mounted) return;
                            Navigator.pop(dialogCtx);
                            ScaffoldMessenger.of(context).showSnackBar(
                              const SnackBar(
                                content: Text(
                                  'Tenant accepted and lease created!',
                                ),
                              ),
                            );
                          } catch (e) {
                            setDialogState(() => isSubmitting = false);
                            ScaffoldMessenger.of(context).showSnackBar(
                              SnackBar(content: Text('Failed to accept: $e')),
                            );
                          }
                        },
                  child: isSubmitting
                      ? const SizedBox(
                          width: 18,
                          height: 18,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Text('Confirm & Create Lease'),
                ),
              ],
            );
          },
        );
      },
    );
  }

  // ───────────────────────── TAB 1: PROPERTIES ─────────────────────────

  Widget _buildPropertiesTab() {
    return StreamBuilder<QuerySnapshot<Map<String, dynamic>>>(
      stream: _propertyService.getLandlordPropertiesStream(),
      builder: (context, snapshot) {
        if (snapshot.connectionState == ConnectionState.waiting) {
          return const Center(child: CircularProgressIndicator());
        }

        final properties = snapshot.data?.docs ?? [];
        if (properties.isEmpty) {
          return Center(
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Icon(Icons.apartment, size: 64, color: Colors.grey.shade400),
                const SizedBox(height: 12),
                Text(
                  'No properties added yet.',
                  style: Theme.of(context).textTheme.titleMedium
                      ?.copyWith(color: Colors.grey.shade600),
                ),
                const SizedBox(height: 16),
                ElevatedButton.icon(
                  icon: const Icon(Icons.add),
                  label: const Text('Add First Property'),
                  onPressed: _showAddPropertyDialog,
                ),
              ],
            ),
          );
        }

        return ListView.separated(
          padding: const EdgeInsets.all(16),
          itemCount: properties.length,
          separatorBuilder: (_, __) => const SizedBox(height: 12),
          itemBuilder: (context, index) {
            final prop = properties[index];
            final data = prop.data();
            final name = data['name'] ?? 'Unnamed';
            final address = data['address'] ?? '';
            final joinCode = data['joinCode'] ?? '';

            return Card(
              elevation: 2,
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(12),
              ),
              child: InkWell(
                borderRadius: BorderRadius.circular(12),
                onTap: () {
                  Navigator.push(
                    context,
                    MaterialPageRoute(
                      builder: (_) => PropertyDetailsScreen(
                        propertyId: prop.id,
                        propertyData: data,
                      ),
                    ),
                  );
                },
                child: Padding(
                  padding: const EdgeInsets.all(16.0),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          Expanded(
                            child: Text(
                              name,
                              style: const TextStyle(
                                fontSize: 18,
                                fontWeight: FontWeight.bold,
                              ),
                            ),
                          ),
                          Container(
                            padding: const EdgeInsets.symmetric(
                              horizontal: 8,
                              vertical: 4,
                            ),
                            decoration: BoxDecoration(
                              color: Colors.blue.shade50,
                              borderRadius: BorderRadius.circular(6),
                              border: Border.all(color: Colors.blue.shade200),
                            ),
                            child: Text(
                              'Code: $joinCode',
                              style: const TextStyle(
                                fontWeight: FontWeight.bold,
                                color: Colors.blueAccent,
                                letterSpacing: 1,
                              ),
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 6),
                      Text(
                        address,
                        style: TextStyle(
                          color: Colors.grey.shade700,
                          fontSize: 14,
                        ),
                      ),
                      const SizedBox(height: 12),
                      Row(
                        mainAxisAlignment: MainAxisAlignment.end,
                        children: [
                          Text(
                            'Manage Units',
                            style: TextStyle(
                              color: Theme.of(context).colorScheme.primary,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                          const SizedBox(width: 4),
                          Icon(
                            Icons.arrow_forward_ios,
                            size: 14,
                            color: Theme.of(context).colorScheme.primary,
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              ),
            );
          },
        );
      },
    );
  }

  // ───────────────────────── TAB 2: JOIN REQUESTS ─────────────────────────

  Widget _buildJoinRequestsTab() {
    return StreamBuilder<QuerySnapshot<Map<String, dynamic>>>(
      stream: _propertyService.getPendingJoinRequestsStream(),
      builder: (context, snapshot) {
        if (snapshot.connectionState == ConnectionState.waiting) {
          return const Center(child: CircularProgressIndicator());
        }

        final requests = snapshot.data?.docs ?? [];
        if (requests.isEmpty) {
          return Center(
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Icon(
                  Icons.inbox_outlined,
                  size: 64,
                  color: Colors.grey.shade400,
                ),
                const SizedBox(height: 12),
                Text(
                  'No pending join requests.',
                  style: Theme.of(context).textTheme.titleMedium
                      ?.copyWith(color: Colors.grey.shade600),
                ),
                const SizedBox(height: 6),
                Text(
                  'Share your property join code with tenants.',
                  style: TextStyle(color: Colors.grey.shade500),
                ),
              ],
            ),
          );
        }

        return ListView.separated(
          padding: const EdgeInsets.all(16),
          itemCount: requests.length,
          separatorBuilder: (_, __) => const SizedBox(height: 12),
          itemBuilder: (context, index) {
            final req = requests[index];
            final data = req.data();
            final tenantName = data['tenantName'] ?? 'Applicant';
            final tenantPhone = data['tenantPhone'] ?? '';
            final propertyName = data['propertyName'] ?? 'Property';
            final propertyId = data['propertyId'] ?? '';
            final message = data['message'] ?? '';

            return Card(
              elevation: 2,
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(12),
              ),
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        CircleAvatar(
                          backgroundColor: Colors.blue.shade100,
                          child: const Icon(Icons.person, color: Colors.blue),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                tenantName,
                                style: const TextStyle(
                                  fontWeight: FontWeight.bold,
                                  fontSize: 16,
                                ),
                              ),
                              if (tenantPhone.isNotEmpty)
                                Text(
                                  tenantPhone,
                                  style: TextStyle(
                                    color: Colors.grey.shade600,
                                    fontSize: 13,
                                  ),
                                ),
                            ],
                          ),
                        ),
                        Container(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 8,
                            vertical: 4,
                          ),
                          decoration: BoxDecoration(
                            color: Colors.amber.shade50,
                            border: Border.all(color: Colors.amber.shade300),
                            borderRadius: BorderRadius.circular(6),
                          ),
                          child: const Text(
                            'Pending',
                            style: TextStyle(
                              fontSize: 12,
                              fontWeight: FontWeight.w600,
                              color: Colors.orange,
                            ),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 10),
                    Text(
                      'Applying for: $propertyName',
                      style: const TextStyle(fontWeight: FontWeight.w500),
                    ),
                    if (message.isNotEmpty) ...[
                      const SizedBox(height: 4),
                      Text(
                        'Note: "$message"',
                        style: TextStyle(
                          fontStyle: FontStyle.italic,
                          color: Colors.grey.shade700,
                        ),
                      ),
                    ],
                    const SizedBox(height: 14),
                    Row(
                      mainAxisAlignment: MainAxisAlignment.end,
                      children: [
                        OutlinedButton(
                          style: OutlinedButton.styleFrom(
                            foregroundColor: Colors.red,
                          ),
                          onPressed: () async {
                            final confirm = await showDialog<bool>(
                              context: context,
                              builder: (ctx) => AlertDialog(
                                title: const Text('Reject Request?'),
                                content: Text(
                                  'Are you sure you want to decline $tenantName?',
                                ),
                                actions: [
                                  TextButton(
                                    onPressed: () => Navigator.pop(ctx, false),
                                    child: const Text('Cancel'),
                                  ),
                                  ElevatedButton(
                                    style: ElevatedButton.styleFrom(
                                      backgroundColor: Colors.red,
                                    ),
                                    onPressed: () => Navigator.pop(ctx, true),
                                    child: const Text(
                                      'Reject',
                                      style: TextStyle(color: Colors.white),
                                    ),
                                  ),
                                ],
                              ),
                            );
                            if (confirm == true) {
                              await _propertyService.rejectJoinRequest(req.id);
                            }
                          },
                          child: const Text('Decline'),
                        ),
                        const SizedBox(width: 8),
                        ElevatedButton(
                          onPressed: () {
                            _showAcceptDialog(
                              joinRequestId: req.id,
                              propertyId: propertyId,
                              applicantName: tenantName,
                            );
                          },
                          child: const Text('Accept & Assign Room'),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            );
          },
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(switch (_currentIndex) {
          0 => 'Properties & Rooms',
          1 => 'Join Requests',
          2 => 'Monthly Billing',
          _ => 'Payment Review',
        }),
        actions: [
          IconButton(
            icon: const Icon(Icons.logout),
            tooltip: 'Sign Out',
            onPressed: () => AuthService().signOut(),
          ),
        ],
      ),
      body: switch (_currentIndex) {
        0 => _buildPropertiesTab(),
        1 => _buildJoinRequestsTab(),
        2 => MonthlyBillingScreen(repository: _propertyService),
        _ => LandlordPaymentReviewScreen(repository: _paymentReviewRepository),
      },
      floatingActionButton: _currentIndex == 0
          ? FloatingActionButton.extended(
              onPressed: _showAddPropertyDialog,
              icon: const Icon(Icons.add),
              label: const Text('New Property'),
            )
          : null,
      bottomNavigationBar: NavigationBar(
        selectedIndex: _currentIndex,
        onDestinationSelected: (idx) => setState(() => _currentIndex = idx),
        destinations: const [
          NavigationDestination(
            icon: Icon(Icons.apartment_outlined),
            selectedIcon: Icon(Icons.apartment),
            label: 'Properties',
          ),
          NavigationDestination(
            icon: Icon(Icons.mark_email_unread_outlined),
            selectedIcon: Icon(Icons.mark_email_unread),
            label: 'Join Requests',
          ),
          NavigationDestination(
            icon: Icon(Icons.receipt_long_outlined),
            selectedIcon: Icon(Icons.receipt_long),
            label: 'Billing',
          ),
          NavigationDestination(
            icon: Icon(Icons.fact_check_outlined),
            selectedIcon: Icon(Icons.fact_check),
            label: 'Payments',
          ),
        ],
      ),
    );
  }
}
