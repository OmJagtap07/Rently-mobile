import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:cloud_firestore/cloud_firestore.dart';

import '../../services/property_service.dart';
import '../../services/property_payment_details.dart';

class PropertyDetailsScreen extends StatefulWidget {
  final String propertyId;
  final Map<String, dynamic> propertyData;

  const PropertyDetailsScreen({
    super.key,
    required this.propertyId,
    required this.propertyData,
  });

  @override
  State<PropertyDetailsScreen> createState() => _PropertyDetailsScreenState();
}

class _PropertyDetailsScreenState extends State<PropertyDetailsScreen> {
  final PropertyService _propertyService = PropertyService();
  late Map<String, dynamic> _propertyData;

  @override
  void initState() {
    super.initState();
    _propertyData = Map<String, dynamic>.from(widget.propertyData);
  }

  void _showEditUpiConfigurationDialog() {
    final formKey = GlobalKey<FormState>();
    final upiIdCtrl = TextEditingController(
      text: _propertyData['upiId'] as String? ?? '',
    );
    final qrImageUrlCtrl = TextEditingController(
      text: _propertyData['upiQrImageUrl'] as String? ?? '',
    );
    final displayNameCtrl = TextEditingController(
      text: _propertyData['upiDisplayName'] as String? ?? '',
    );
    bool isSaving = false;
    String? errorText;

    showDialog<void>(
      context: context,
      builder: (dialogContext) => StatefulBuilder(
        builder: (context, setDialogState) => AlertDialog(
          title: const Text('Property UPI Details'),
          content: SingleChildScrollView(
            child: Form(
              key: formKey,
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  TextFormField(
                    controller: upiIdCtrl,
                    keyboardType: TextInputType.emailAddress,
                    decoration: const InputDecoration(
                      labelText: 'UPI ID *',
                      hintText: 'name@bank',
                      border: OutlineInputBorder(),
                    ),
                    validator: validateUpiId,
                  ),
                  const SizedBox(height: 12),
                  TextFormField(
                    controller: qrImageUrlCtrl,
                    keyboardType: TextInputType.url,
                    decoration: const InputDecoration(
                      labelText: 'QR Image HTTPS URL *',
                      border: OutlineInputBorder(),
                    ),
                    validator: validateUpiQrImageUrl,
                  ),
                  const SizedBox(height: 12),
                  TextFormField(
                    controller: displayNameCtrl,
                    textCapitalization: TextCapitalization.words,
                    decoration: const InputDecoration(
                      labelText: 'Recipient Display Name *',
                      border: OutlineInputBorder(),
                    ),
                    validator: validateUpiDisplayName,
                  ),
                  if (errorText != null) ...[
                    const SizedBox(height: 12),
                    Text(
                      errorText!,
                      style: TextStyle(
                        color: Theme.of(context).colorScheme.error,
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ),
          actions: [
            TextButton(
              onPressed: isSaving ? null : () => Navigator.pop(dialogContext),
              child: const Text('Cancel'),
            ),
            ElevatedButton(
              onPressed: isSaving
                  ? null
                  : () async {
                      if (!formKey.currentState!.validate()) return;
                      setDialogState(() {
                        isSaving = true;
                        errorText = null;
                      });
                      try {
                        await _propertyService.updatePropertyUpiDetails(
                          propertyId: widget.propertyId,
                          upiId: upiIdCtrl.text,
                          upiQrImageUrl: qrImageUrlCtrl.text,
                          upiDisplayName: displayNameCtrl.text,
                        );
                        if (!mounted || !dialogContext.mounted) return;
                        setState(() {
                          _propertyData
                            ..['upiId'] = upiIdCtrl.text.trim()
                            ..['upiQrImageUrl'] = qrImageUrlCtrl.text.trim()
                            ..['upiDisplayName'] = displayNameCtrl.text.trim();
                        });
                        Navigator.pop(dialogContext);
                        ScaffoldMessenger.of(context).showSnackBar(
                          const SnackBar(
                            content: Text('Property UPI details saved.'),
                          ),
                        );
                      } catch (error) {
                        setDialogState(() {
                          isSaving = false;
                          errorText = 'Could not save UPI details: $error';
                        });
                      }
                    },
              child: isSaving
                  ? const SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Text('Save'),
            ),
          ],
        ),
      ),
    );
  }

  // ───────────────────────── ADD UNIT SHEET ─────────────────────────

  void _showAddUnitSheet() {
    final roomCtrl = TextEditingController();
    final rentCtrl = TextEditingController();
    final formKey = GlobalKey<FormState>();
    bool isSaving = false;

    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (ctx) {
        return StatefulBuilder(
          builder: (context, setSheetState) {
            return Padding(
              padding: EdgeInsets.only(
                left: 20,
                right: 20,
                top: 24,
                bottom: MediaQuery.of(context).viewInsets.bottom + 24,
              ),
              child: Form(
                key: formKey,
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Text(
                      'Add Unit / Room',
                      style: Theme.of(context).textTheme.titleLarge
                          ?.copyWith(fontWeight: FontWeight.bold),
                    ),
                    const SizedBox(height: 16),
                    TextFormField(
                      controller: roomCtrl,
                      decoration: const InputDecoration(
                        labelText: 'Room / Unit Number *',
                        hintText: 'e.g. 101 or 2A',
                        border: OutlineInputBorder(),
                        prefixIcon: Icon(Icons.meeting_room),
                      ),
                      validator: (val) {
                        if (val == null || val.trim().isEmpty)
                          return 'Enter room number';
                        return null;
                      },
                    ),
                    const SizedBox(height: 12),
                    TextFormField(
                      controller: rentCtrl,
                      keyboardType: TextInputType.number,
                      decoration: const InputDecoration(
                        labelText: 'Monthly Base Rent (₹) *',
                        hintText: 'e.g. 8000',
                        border: OutlineInputBorder(),
                        prefixIcon: Icon(Icons.currency_rupee),
                      ),
                      validator: (val) {
                        if (val == null || val.trim().isEmpty)
                          return 'Enter rent amount';
                        final parsed = int.tryParse(val.trim());
                        if (parsed == null || parsed <= 0)
                          return 'Enter a valid amount';
                        return null;
                      },
                    ),
                    const SizedBox(height: 20),
                    ElevatedButton(
                      style: ElevatedButton.styleFrom(
                        padding: const EdgeInsets.symmetric(vertical: 14),
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(10),
                        ),
                      ),
                      onPressed: isSaving
                          ? null
                          : () async {
                              if (!formKey.currentState!.validate()) return;
                              setSheetState(() => isSaving = true);
                              try {
                                await _propertyService.createUnit(
                                  propertyId: widget.propertyId,
                                  roomNumber: roomCtrl.text.trim(),
                                  baseRentRupees: int.parse(
                                    rentCtrl.text.trim(),
                                  ),
                                );
                                if (!mounted) return;
                                Navigator.pop(ctx);
                                ScaffoldMessenger.of(context).showSnackBar(
                                  const SnackBar(
                                    content: Text('Unit added successfully!'),
                                  ),
                                );
                              } catch (e) {
                                setSheetState(() => isSaving = false);
                                ScaffoldMessenger.of(context).showSnackBar(
                                  SnackBar(
                                    content: Text('Error adding unit: $e'),
                                  ),
                                );
                              }
                            },
                      child: isSaving
                          ? const SizedBox(
                              width: 20,
                              height: 20,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : const Text(
                              'Add Unit',
                              style: TextStyle(fontSize: 16),
                            ),
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

  // ───────────────────────── OCCUPIED ROOM DIALOG (END LEASE & HISTORY) ─────────────────────────

  void _showOccupiedUnitDialog({
    required String unitId,
    required String roomNumber,
    required String leaseId,
  }) {
    showDialog(
      context: context,
      builder: (dialogCtx) {
        return FutureBuilder<DocumentSnapshot<Map<String, dynamic>>>(
          future: _propertyService.getLease(leaseId),
          builder: (context, snapshot) {
            if (snapshot.connectionState == ConnectionState.waiting) {
              return const AlertDialog(
                content: SizedBox(
                  height: 80,
                  child: Center(child: CircularProgressIndicator()),
                ),
              );
            }

            final leaseData = snapshot.data?.data();
            if (leaseData == null) {
              return AlertDialog(
                title: Text('Room $roomNumber'),
                content: const Text('Lease details not found.'),
                actions: [
                  TextButton(
                    onPressed: () => Navigator.pop(dialogCtx),
                    child: const Text('Close'),
                  ),
                ],
              );
            }

            final tenantName = leaseData['tenantName'] ?? 'Tenant';
            final tenantPhone = leaseData['tenantPhone'] ?? '';
            final joiningDate = leaseData['joiningDate'] ?? 'N/A';
            final rentPaise = (leaseData['currentBaseRent'] ?? 0) as int;
            final rentRupees = (rentPaise / 100).toStringAsFixed(0);

            return AlertDialog(
              title: Row(
                children: [
                  const Icon(Icons.person, color: Colors.blue),
                  const SizedBox(width: 8),
                  Expanded(child: Text('Room $roomNumber Tenancy')),
                ],
              ),
              content: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    tenantName,
                    style: const TextStyle(
                      fontSize: 18,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                  if (tenantPhone.isNotEmpty) ...[
                    const SizedBox(height: 2),
                    Text(
                      tenantPhone,
                      style: TextStyle(
                        color: Colors.grey.shade600,
                        fontSize: 13,
                      ),
                    ),
                  ],
                  const Divider(height: 20),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      const Text(
                        'Joining Date:',
                        style: TextStyle(color: Colors.black54),
                      ),
                      Text(
                        joiningDate,
                        style: const TextStyle(fontWeight: FontWeight.w600),
                      ),
                    ],
                  ),
                  const SizedBox(height: 6),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      const Text(
                        'Monthly Rent:',
                        style: TextStyle(color: Colors.black54),
                      ),
                      Text(
                        '₹$rentRupees',
                        style: const TextStyle(
                          fontWeight: FontWeight.bold,
                          color: Colors.blue,
                        ),
                      ),
                    ],
                  ),
                ],
              ),
              actions: [
                TextButton(
                  onPressed: () {
                    Navigator.pop(dialogCtx);
                    _showRoomHistoryDialog(
                      unitId: unitId,
                      roomNumber: roomNumber,
                    );
                  },
                  child: const Text('Room History'),
                ),
                ElevatedButton(
                  style: ElevatedButton.styleFrom(backgroundColor: Colors.red),
                  onPressed: () {
                    Navigator.pop(dialogCtx);
                    _showEndLeaseDialog(
                      leaseId: leaseId,
                      roomNumber: roomNumber,
                      tenantName: tenantName,
                      joiningDate: joiningDate,
                    );
                  },
                  child: const Text(
                    'End Lease / Move Out',
                    style: TextStyle(color: Colors.white),
                  ),
                ),
              ],
            );
          },
        );
      },
    );
  }

  // ───────────────────────── END LEASE DIALOG ─────────────────────────

  void _showEndLeaseDialog({
    required String leaseId,
    required String roomNumber,
    required String tenantName,
    required String joiningDate,
  }) {
    DateTime endDate = DateTime.now();
    final reasonCtrl = TextEditingController();
    bool isSubmitting = false;

    showDialog(
      context: context,
      builder: (dialogCtx) {
        return StatefulBuilder(
          builder: (context, setDialogState) {
            final dateStr =
                '${endDate.year}-${endDate.month.toString().padLeft(2, '0')}-${endDate.day.toString().padLeft(2, '0')}';

            return AlertDialog(
              title: Text('End Lease for Room $roomNumber'),
              content: SingleChildScrollView(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'Ending tenancy for $tenantName. The room will become vacant, and historical records will be preserved.',
                    ),
                    const SizedBox(height: 16),
                    const Text(
                      'End / Move-out Date *',
                      style: TextStyle(fontWeight: FontWeight.w600),
                    ),
                    const SizedBox(height: 4),
                    Row(
                      children: [
                        Text(
                          dateStr,
                          style: const TextStyle(
                            fontSize: 16,
                            fontWeight: FontWeight.bold,
                          ),
                        ),
                        const Spacer(),
                        TextButton(
                          onPressed: () async {
                            final picked = await showDatePicker(
                              context: context,
                              initialDate: endDate,
                              firstDate: DateTime(2020),
                              lastDate: DateTime(2035),
                            );
                            if (picked != null) {
                              setDialogState(() => endDate = picked);
                            }
                          },
                          child: const Text('Change Date'),
                        ),
                      ],
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      controller: reasonCtrl,
                      decoration: const InputDecoration(
                        labelText: 'Reason for Leaving (Optional)',
                        hintText: 'e.g. Relocating, lease expired',
                        border: OutlineInputBorder(),
                      ),
                      maxLines: 2,
                    ),
                  ],
                ),
              ),
              actions: [
                TextButton(
                  onPressed: () => Navigator.pop(dialogCtx),
                  child: const Text('Cancel'),
                ),
                ElevatedButton(
                  style: ElevatedButton.styleFrom(backgroundColor: Colors.red),
                  onPressed: isSubmitting
                      ? null
                      : () async {
                          setDialogState(() => isSubmitting = true);
                          try {
                            await _propertyService.endLease(
                              leaseId: leaseId,
                              endDate: dateStr,
                              endReason: reasonCtrl.text.trim(),
                            );
                            if (!mounted) return;
                            Navigator.pop(dialogCtx);
                            ScaffoldMessenger.of(context).showSnackBar(
                              const SnackBar(
                                content: Text(
                                  'Lease ended. Room is now vacant.',
                                ),
                              ),
                            );
                          } catch (e) {
                            setDialogState(() => isSubmitting = false);
                            ScaffoldMessenger.of(context).showSnackBar(
                              SnackBar(content: Text('Error ending lease: $e')),
                            );
                          }
                        },
                  child: isSubmitting
                      ? const SizedBox(
                          width: 18,
                          height: 18,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Text(
                          'Confirm End Lease',
                          style: TextStyle(color: Colors.white),
                        ),
                ),
              ],
            );
          },
        );
      },
    );
  }

  // ───────────────────────── ROOM HISTORY DIALOG ─────────────────────────

  void _showRoomHistoryDialog({
    required String unitId,
    required String roomNumber,
  }) {
    showDialog(
      context: context,
      builder: (dialogCtx) {
        return AlertDialog(
          title: Text('Room $roomNumber Tenancy History'),
          content: SizedBox(
            width: double.maxFinite,
            child: StreamBuilder<QuerySnapshot<Map<String, dynamic>>>(
              stream: _propertyService.getUnitLeasesStream(unitId),
              builder: (context, snapshot) {
                if (snapshot.connectionState == ConnectionState.waiting) {
                  return const SizedBox(
                    height: 80,
                    child: Center(child: CircularProgressIndicator()),
                  );
                }

                final leases = snapshot.data?.docs ?? [];
                if (leases.isEmpty) {
                  return const Padding(
                    padding: EdgeInsets.symmetric(vertical: 16.0),
                    child: Text(
                      'No historical tenancies recorded for this room.',
                    ),
                  );
                }

                return ListView.separated(
                  shrinkWrap: true,
                  itemCount: leases.length,
                  separatorBuilder: (_, __) => const Divider(),
                  itemBuilder: (context, index) {
                    final data = leases[index].data();
                    final tenant = data['tenantName'] ?? 'Tenant';
                    final joinDate = data['joiningDate'] ?? 'N/A';
                    final endDate = data['endDate'] ?? 'Present';
                    final status = data['status'] ?? 'ended';
                    final isActive = status == 'active';

                    return ListTile(
                      contentPadding: EdgeInsets.zero,
                      leading: CircleAvatar(
                        backgroundColor: isActive
                            ? Colors.green.shade50
                            : Colors.grey.shade100,
                        child: Icon(
                          Icons.person,
                          color: isActive ? Colors.green : Colors.grey,
                        ),
                      ),
                      title: Text(
                        tenant,
                        style: const TextStyle(fontWeight: FontWeight.bold),
                      ),
                      subtitle: Text('$joinDate → $endDate'),
                      trailing: Chip(
                        label: Text(
                          isActive ? 'Active' : 'Ended',
                          style: TextStyle(
                            fontSize: 11,
                            color: isActive
                                ? Colors.green.shade800
                                : Colors.grey.shade700,
                          ),
                        ),
                        backgroundColor: isActive
                            ? Colors.green.shade100
                            : Colors.grey.shade200,
                      ),
                    );
                  },
                );
              },
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(dialogCtx),
              child: const Text('Close'),
            ),
          ],
        );
      },
    );
  }

  // ───────────────────────── BUILD VIEW ─────────────────────────

  @override
  Widget build(BuildContext context) {
    final name = _propertyData['name'] ?? 'Property';
    final address = _propertyData['address'] ?? '';
    final joinCode = _propertyData['joinCode'] ?? '';

    return Scaffold(
      appBar: AppBar(title: Text(name)),
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // Property Header Card
          Container(
            padding: const EdgeInsets.all(16),
            color: Theme.of(context).colorScheme.primaryContainer
                .withOpacity(0.4),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Icon(
                      Icons.location_on,
                      size: 20,
                      color: Colors.blueGrey,
                    ),
                    const SizedBox(width: 6),
                    Expanded(
                      child: Text(
                        address,
                        style: const TextStyle(
                          fontSize: 14,
                          color: Colors.black87,
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 12),
                Row(
                  children: [
                    const Text(
                      'Tenant Join Code: ',
                      style: TextStyle(fontWeight: FontWeight.w600),
                    ),
                    Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 10,
                        vertical: 4,
                      ),
                      decoration: BoxDecoration(
                        color: Colors.blue.shade50,
                        border: Border.all(color: Colors.blue.shade300),
                        borderRadius: BorderRadius.circular(8),
                      ),
                      child: Text(
                        joinCode,
                        style: const TextStyle(
                          fontSize: 16,
                          fontWeight: FontWeight.bold,
                          letterSpacing: 2,
                          color: Colors.blueAccent,
                        ),
                      ),
                    ),
                    IconButton(
                      icon: const Icon(
                        Icons.copy,
                        size: 20,
                        color: Colors.blueGrey,
                      ),
                      tooltip: 'Copy Code',
                      onPressed: () {
                        Clipboard.setData(ClipboardData(text: joinCode));
                        ScaffoldMessenger.of(context).showSnackBar(
                          const SnackBar(
                            content: Text('Join code copied to clipboard!'),
                          ),
                        );
                      },
                    ),
                  ],
                ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
            child: Card(
              child: ListTile(
                leading: const Icon(Icons.qr_code_2),
                title: const Text('Property UPI Payment Details'),
                subtitle: Text(
                  (_propertyData['upiId'] as String?)?.isNotEmpty == true
                      ? '${_propertyData['upiDisplayName'] ?? ''} · ${_propertyData['upiId']}'
                      : 'Not configured',
                ),
                trailing: const Icon(Icons.edit),
                onTap: _showEditUpiConfigurationDialog,
              ),
            ),
          ),
          // Units List Header
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text(
                  'Units / Rooms',
                  style: Theme.of(context).textTheme.titleMedium
                      ?.copyWith(fontWeight: FontWeight.bold),
                ),
                TextButton.icon(
                  icon: const Icon(Icons.add, size: 18),
                  label: const Text('Add Room'),
                  onPressed: _showAddUnitSheet,
                ),
              ],
            ),
          ),
          const Divider(height: 1),
          // Units Stream
          Expanded(
            child: StreamBuilder<QuerySnapshot<Map<String, dynamic>>>(
              stream: _propertyService.getPropertyUnitsStream(
                widget.propertyId,
              ),
              builder: (context, snapshot) {
                if (snapshot.connectionState == ConnectionState.waiting) {
                  return const Center(child: CircularProgressIndicator());
                }

                final docs = snapshot.data?.docs ?? [];
                if (docs.isEmpty) {
                  return Center(
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Icon(
                          Icons.meeting_room_outlined,
                          size: 48,
                          color: Colors.grey.shade400,
                        ),
                        const SizedBox(height: 8),
                        Text(
                          'No units added yet.',
                          style: TextStyle(color: Colors.grey.shade600),
                        ),
                        const SizedBox(height: 12),
                        OutlinedButton.icon(
                          icon: const Icon(Icons.add),
                          label: const Text('Add First Unit'),
                          onPressed: _showAddUnitSheet,
                        ),
                      ],
                    ),
                  );
                }

                return ListView.separated(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 16,
                    vertical: 8,
                  ),
                  itemCount: docs.length,
                  separatorBuilder: (_, __) => const SizedBox(height: 8),
                  itemBuilder: (context, index) {
                    final data = docs[index].data();
                    final unitId = docs[index].id;
                    final roomNumber = data['roomNumber'] ?? '';
                    final baseRentPaise = (data['baseRent'] ?? 0) as int;
                    final baseRentRupees = (baseRentPaise / 100)
                        .toStringAsFixed(0);
                    final isVacant = data['status'] == 'vacant';
                    final currentLeaseId = data['currentLeaseId'] as String?;

                    return Card(
                      elevation: 1,
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(10),
                      ),
                      child: ListTile(
                        leading: CircleAvatar(
                          backgroundColor: isVacant
                              ? Colors.green.shade50
                              : Colors.orange.shade50,
                          child: Icon(
                            isVacant
                                ? Icons.check_circle_outline
                                : Icons.person,
                            color: isVacant ? Colors.green : Colors.orange,
                          ),
                        ),
                        title: Text(
                          'Room $roomNumber',
                          style: const TextStyle(fontWeight: FontWeight.bold),
                        ),
                        subtitle: Text('Base Rent: ₹$baseRentRupees / month'),
                        trailing: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Chip(
                              label: Text(
                                isVacant ? 'Vacant' : 'Occupied',
                                style: TextStyle(
                                  fontSize: 12,
                                  color: isVacant
                                      ? Colors.green.shade800
                                      : Colors.orange.shade800,
                                  fontWeight: FontWeight.w600,
                                ),
                              ),
                              backgroundColor: isVacant
                                  ? Colors.green.shade100
                                  : Colors.orange.shade100,
                            ),
                            const SizedBox(width: 4),
                            Icon(
                              Icons.chevron_right,
                              color: Colors.grey.shade400,
                            ),
                          ],
                        ),
                        onTap: () {
                          if (!isVacant && currentLeaseId != null) {
                            _showOccupiedUnitDialog(
                              unitId: unitId,
                              roomNumber: roomNumber,
                              leaseId: currentLeaseId,
                            );
                          } else {
                            _showRoomHistoryDialog(
                              unitId: unitId,
                              roomNumber: roomNumber,
                            );
                          }
                        },
                      ),
                    );
                  },
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}
