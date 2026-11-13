import 'package:flutter/material.dart';

import '../../services/monthly_billing_repository.dart';
import '../../services/property_service.dart';

class MonthlyBillingScreen extends StatefulWidget {
  MonthlyBillingScreen({
    super.key,
    MonthlyBillingRepository? repository,
    DateTime? initialMonth,
  }) : repository = repository ?? PropertyService(),
       initialMonth = initialMonth ?? DateTime.now();

  final MonthlyBillingRepository repository;
  final DateTime initialMonth;

  @override
  State<MonthlyBillingScreen> createState() => _MonthlyBillingScreenState();
}

class _MonthlyBillingScreenState extends State<MonthlyBillingScreen> {
  late DateTime _selectedMonth;
  late final Stream<List<BillingLease>> _activeLeases;
  late Stream<Map<String, RentChargeRecord>> _charges;

  String get _billingMonth =>
      '${_selectedMonth.year.toString().padLeft(4, '0')}-'
      '${_selectedMonth.month.toString().padLeft(2, '0')}';

  String get _monthLabel {
    const months = [
      'January',
      'February',
      'March',
      'April',
      'May',
      'June',
      'July',
      'August',
      'September',
      'October',
      'November',
      'December',
    ];
    return '${months[_selectedMonth.month - 1]} ${_selectedMonth.year}';
  }

  @override
  void initState() {
    super.initState();
    _selectedMonth = DateTime(
      widget.initialMonth.year,
      widget.initialMonth.month,
    );
    _activeLeases = widget.repository.watchLandlordLeases();
    _watchCharges();
  }

  void _watchCharges() {
    _charges = widget.repository.watchChargesForMonth(_billingMonth);
  }

  void _changeMonth(int offset) {
    setState(() {
      _selectedMonth = DateTime(
        _selectedMonth.year,
        _selectedMonth.month + offset,
      );
      _watchCharges();
    });
  }

  Future<void> _selectMonth() async {
    final selected = await showDatePicker(
      context: context,
      initialDate: _selectedMonth,
      firstDate: DateTime(2000),
      lastDate: DateTime(2100),
      helpText: 'Select billing month',
    );
    if (selected == null || !mounted) return;
    setState(() {
      _selectedMonth = DateTime(selected.year, selected.month);
      _watchCharges();
    });
  }

  Future<void> _openEditor({
    required BillingLease lease,
    RentChargeRecord? charge,
  }) async {
    final saved = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (context) => _RentChargeEditor(
        repository: widget.repository,
        lease: lease,
        billingMonth: _billingMonth,
        existingCharge: charge,
      ),
    );
    if (saved == true && mounted) {
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('Draft bill saved.')));
    }
  }

  Future<void> _finalize(RentChargeRecord charge) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Finalize bill?'),
        content: const Text(
          'This will lock the bill as a financial record. '
          'Corrections after finalization must use an adjustment.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
          ElevatedButton(
            key: const Key('confirm-finalize-bill'),
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Confirm finalization'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;

    try {
      final result = await widget.repository.finalize(charge.id);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            'Bill finalized: ${formatPaise(result.total)}, due ${result.dueDate}.',
          ),
        ),
      );
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Could not finalize bill: $error')),
      );
    }
  }

  void _showBillDetails(RentChargeRecord charge) {
    showDialog<void>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(charge.status == 'draft' ? 'Draft bill' : 'Finalized bill'),
        content: SizedBox(
          width: double.maxFinite,
          child: _ChargeBreakdown(charge: charge),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Close'),
          ),
        ],
      ),
    );
  }

  Widget _buildLeaseCard(
    BuildContext context,
    BillingLease lease,
    RentChargeRecord? charge,
  ) {
    final hasDraft = charge?.status == 'draft';
    final finalized = charge != null && !hasDraft;
    final leaseActive = lease.status == 'active';
    final statusLabel = charge == null
        ? 'Not prepared'
        : hasDraft
        ? 'Draft'
        : 'Finalized';
    final statusColor = charge == null
        ? Colors.grey
        : hasDraft
        ? Colors.orange
        : Colors.green;

    return Card(
      key: Key('billing-lease-${lease.id}'),
      margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Icon(Icons.person_outline),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    lease.tenantName,
                    style: Theme.of(context).textTheme.titleMedium
                        ?.copyWith(fontWeight: FontWeight.bold),
                  ),
                ),
                Chip(
                  label: Text(statusLabel),
                  labelStyle: TextStyle(
                    color: statusColor.shade800,
                    fontSize: 12,
                  ),
                  backgroundColor: statusColor.shade50,
                ),
              ],
            ),
            Text('${lease.propertyName} · Room ${lease.roomNumber}'),
            const SizedBox(height: 4),
            Text('Current rent: ${formatPaise(lease.currentBaseRent)} / month'),
            if (charge != null) ...[
              const Divider(height: 20),
              _ChargeBreakdown(charge: charge),
            ],
            const SizedBox(height: 10),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                if (leaseActive && (charge == null || hasDraft))
                  OutlinedButton.icon(
                    key: Key('edit-bill-${lease.id}'),
                    onPressed: () => _openEditor(lease: lease, charge: charge),
                    icon: Icon(
                      charge == null ? Icons.add : Icons.edit_outlined,
                    ),
                    label: Text(
                      charge == null ? 'Prepare draft' : 'Edit draft',
                    ),
                  )
                else if (charge != null)
                  OutlinedButton.icon(
                    key: Key('view-bill-${lease.id}'),
                    onPressed: () => _showBillDetails(charge),
                    icon: const Icon(Icons.receipt_long_outlined),
                    label: const Text('View bill'),
                  ),
                if (leaseActive && hasDraft && charge != null)
                  ElevatedButton.icon(
                    key: Key('finalize-bill-${lease.id}'),
                    onPressed: () => _finalize(charge),
                    icon: const Icon(Icons.lock_outline),
                    label: const Text('Finalize'),
                  ),
              ],
            ),
            if (finalized)
              const Text(
                'Finalized bills are read-only. Use an adjustment for corrections.',
                style: TextStyle(fontSize: 12, color: Colors.black54),
              ),
            if (!leaseActive && hasDraft)
              const Text(
                'This lease has ended. The draft is retained for history and cannot be edited or finalized.',
                style: TextStyle(fontSize: 12, color: Colors.black54),
              ),
          ],
        ),
      ),
    );
  }

  Widget _buildLeaseContent(
    List<BillingLease> leases,
    AsyncSnapshot<Map<String, RentChargeRecord>> chargeSnapshot,
  ) {
    if (chargeSnapshot.connectionState == ConnectionState.waiting) {
      return const Center(child: CircularProgressIndicator());
    }
    if (chargeSnapshot.hasError) {
      return Center(
        child: Text('Could not load bills: ${chargeSnapshot.error}'),
      );
    }

    final charges = chargeSnapshot.data ?? const {};
    final eligibleLeases = leases
        .where(
          (lease) =>
              lease.status == 'active' ||
              (lease.status == 'ended' && charges.containsKey(lease.id)),
        )
        .toList();
    if (eligibleLeases.isEmpty) {
      return const Center(
        child: Text('No active leases are eligible for billing.'),
      );
    }

    return ListView.builder(
      itemCount: eligibleLeases.length,
      padding: const EdgeInsets.only(top: 8, bottom: 24),
      itemBuilder: (context, index) {
        final lease = eligibleLeases[index];
        return _buildLeaseCard(context, lease, charges[lease.id]);
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 8, 12, 4),
          child: Row(
            children: [
              IconButton(
                tooltip: 'Previous billing month',
                onPressed: () => _changeMonth(-1),
                icon: const Icon(Icons.chevron_left),
              ),
              Expanded(
                child: TextButton.icon(
                  onPressed: _selectMonth,
                  icon: const Icon(Icons.calendar_month),
                  label: Text(
                    _monthLabel,
                    key: const Key('selected-billing-month'),
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                ),
              ),
              IconButton(
                tooltip: 'Next billing month',
                onPressed: () => _changeMonth(1),
                icon: const Icon(Icons.chevron_right),
              ),
            ],
          ),
        ),
        Text('Bills are due on the 10th of the billing month.'),
        const Divider(),
        Expanded(
          child: StreamBuilder<List<BillingLease>>(
            stream: _activeLeases,
            builder: (context, snapshot) {
              if (snapshot.connectionState == ConnectionState.waiting) {
                return const Center(child: CircularProgressIndicator());
              }
              if (snapshot.hasError) {
                return Center(
                  child: Text('Could not load leases: ${snapshot.error}'),
                );
              }
              return StreamBuilder<Map<String, RentChargeRecord>>(
                stream: _charges,
                builder: (context, chargeSnapshot) => _buildLeaseContent(
                  snapshot.data ?? const [],
                  chargeSnapshot,
                ),
              );
            },
          ),
        ),
      ],
    );
  }
}

class _ChargeBreakdown extends StatelessWidget {
  const _ChargeBreakdown({required this.charge});

  final RentChargeRecord charge;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (final item in charge.lineItems)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 2),
            child: Row(
              children: [
                Expanded(child: Text(item.label)),
                Text(formatPaise(item.amount)),
              ],
            ),
          ),
        const Divider(height: 16),
        Row(
          children: [
            const Expanded(child: Text('Subtotal')),
            Text(formatPaise(charge.subtotal)),
          ],
        ),
        Row(
          children: [
            const Expanded(child: Text('Total')),
            Text(
              formatPaise(charge.total),
              style: const TextStyle(fontWeight: FontWeight.bold),
            ),
          ],
        ),
        Text('Due date: ${charge.dueDate}'),
      ],
    );
  }
}

class _OtherChargeFields {
  _OtherChargeFields({String label = '', String amount = ''})
    : labelController = TextEditingController(text: label),
      amountController = TextEditingController(text: amount);

  final TextEditingController labelController;
  final TextEditingController amountController;

  void dispose() {
    labelController.dispose();
    amountController.dispose();
  }
}

class _RentChargeEditor extends StatefulWidget {
  const _RentChargeEditor({
    required this.repository,
    required this.lease,
    required this.billingMonth,
    required this.existingCharge,
  });

  final MonthlyBillingRepository repository;
  final BillingLease lease;
  final String billingMonth;
  final RentChargeRecord? existingCharge;

  @override
  State<_RentChargeEditor> createState() => _RentChargeEditorState();
}

class _RentChargeEditorState extends State<_RentChargeEditor> {
  final _formKey = GlobalKey<FormState>();
  late final TextEditingController _rentController;
  late final TextEditingController _electricityController;
  late final TextEditingController _maintenanceController;
  late final List<_OtherChargeFields> _otherCharges;
  bool _isSaving = false;
  String? _errorText;

  @override
  void initState() {
    super.initState();
    final items = widget.existingCharge?.lineItems ?? const [];
    String amountFor(String type, {String fallback = '0'}) {
      final matching = items.where((item) => item.type == type).firstOrNull;
      return matching == null ? fallback : _paiseToInput(matching.amount);
    }

    _rentController = TextEditingController(
      text: amountFor(
        'rent',
        fallback: _paiseToInput(widget.lease.currentBaseRent),
      ),
    );
    _electricityController = TextEditingController(
      text: amountFor('electricity'),
    );
    _maintenanceController = TextEditingController(
      text: amountFor('maintenance'),
    );
    _otherCharges = items
        .where((item) => item.type == 'other')
        .map(
          (item) => _OtherChargeFields(
            label: item.label,
            amount: _paiseToInput(item.amount),
          ),
        )
        .toList();
  }

  String _paiseToInput(int amount) {
    final rupees = amount ~/ 100;
    final paise = amount.abs() % 100;
    return paise == 0
        ? '$rupees'
        : '$rupees.${paise.toString().padLeft(2, '0')}';
  }

  List<BillingLineItem>? _lineItems() {
    final rent = parseRupeesToPaise(_rentController.text);
    final electricity = parseRupeesToPaise(_electricityController.text);
    final maintenance = parseRupeesToPaise(_maintenanceController.text);
    if (rent == null || electricity == null || maintenance == null) return null;

    final items = <BillingLineItem>[
      BillingLineItem(type: 'rent', label: 'Rent', amount: rent),
      BillingLineItem(
        type: 'electricity',
        label: 'Electricity',
        amount: electricity,
      ),
      BillingLineItem(
        type: 'maintenance',
        label: 'Maintenance',
        amount: maintenance,
      ),
    ];
    for (final other in _otherCharges) {
      final label = other.labelController.text.trim();
      final amountText = other.amountController.text.trim();
      if (label.isEmpty && amountText.isEmpty) continue;
      final amount = parseRupeesToPaise(amountText);
      if (label.isEmpty || amount == null) return null;
      items.add(BillingLineItem(type: 'other', label: label, amount: amount));
    }
    return items;
  }

  int? get _previewTotal {
    final items = _lineItems();
    if (items == null) return null;
    try {
      return widget.repository.calculateSubtotal(items);
    } on ArgumentError {
      return null;
    }
  }

  String? _validateAmount(String? value) {
    if (parseRupeesToPaise(value ?? '') == null) {
      return 'Enter a valid amount (up to 2 decimal places).';
    }
    return null;
  }

  Future<void> _saveDraft() async {
    if (!_formKey.currentState!.validate()) return;
    final lineItems = _lineItems();
    if (lineItems == null || lineItems.length > 10) {
      setState(() {
        _errorText = lineItems == null
            ? 'Complete each other charge with a label and valid amount.'
            : 'A bill can contain at most 10 line items.';
      });
      return;
    }

    setState(() {
      _isSaving = true;
      _errorText = null;
    });
    try {
      await widget.repository.saveDraft(
        lease: widget.lease,
        billingMonth: widget.billingMonth,
        lineItems: lineItems,
        expectedUpdatedAt: widget.existingCharge?.updatedAt,
      );
      if (mounted) Navigator.pop(context, true);
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _isSaving = false;
        _errorText = 'Could not save draft: $error';
      });
    }
  }

  Widget _amountField({
    Key? key,
    required String label,
    required TextEditingController controller,
    bool readOnly = false,
  }) {
    return TextFormField(
      key: key,
      controller: controller,
      readOnly: readOnly,
      keyboardType: const TextInputType.numberWithOptions(decimal: true),
      decoration: InputDecoration(
        labelText: label,
        prefixText: '₹ ',
        border: const OutlineInputBorder(),
      ),
      validator: _validateAmount,
      onChanged: (_) => setState(() {}),
    );
  }

  @override
  void dispose() {
    _rentController.dispose();
    _electricityController.dispose();
    _maintenanceController.dispose();
    for (final item in _otherCharges) {
      item.dispose();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.fromLTRB(
        20,
        20,
        20,
        MediaQuery.of(context).viewInsets.bottom + 20,
      ),
      child: Form(
        key: _formKey,
        child: SingleChildScrollView(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                widget.existingCharge == null
                    ? 'Prepare draft bill'
                    : 'Edit draft bill',
                style: Theme.of(context).textTheme.titleLarge,
              ),
              const SizedBox(height: 4),
              Text(
                '${widget.lease.tenantName} · ${widget.lease.propertyName} · '
                'Room ${widget.lease.roomNumber}',
              ),
              Text('Billing month: ${widget.billingMonth}'),
              Text('Due date: ${widget.billingMonth}-10'),
              const SizedBox(height: 16),
              _amountField(
                key: const Key('rent-amount'),
                label: 'Monthly rent (from active lease)',
                controller: _rentController,
                readOnly: true,
              ),
              const SizedBox(height: 12),
              _amountField(
                key: const Key('electricity-amount'),
                label: 'Actual electricity charge',
                controller: _electricityController,
              ),
              const SizedBox(height: 12),
              _amountField(
                key: const Key('maintenance-amount'),
                label: 'Maintenance charge',
                controller: _maintenanceController,
              ),
              const SizedBox(height: 16),
              Row(
                children: [
                  Expanded(
                    child: Text(
                      'Other charges',
                      style: Theme.of(context).textTheme.titleSmall,
                    ),
                  ),
                  TextButton.icon(
                    key: const Key('add-other-charge'),
                    onPressed: _otherCharges.length >= 7
                        ? null
                        : () => setState(
                            () => _otherCharges.add(_OtherChargeFields()),
                          ),
                    icon: const Icon(Icons.add),
                    label: Text('Add (${_otherCharges.length}/7)'),
                  ),
                ],
              ),
              for (var index = 0; index < _otherCharges.length; index++)
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: Row(
                    children: [
                      Expanded(
                        flex: 3,
                        child: TextFormField(
                          key: Key('other-label-$index'),
                          controller: _otherCharges[index].labelController,
                          decoration: InputDecoration(
                            labelText: 'Other charge ${index + 1}',
                            border: const OutlineInputBorder(),
                          ),
                          onChanged: (_) => setState(() {}),
                        ),
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        flex: 2,
                        child: _amountField(
                          key: Key('other-amount-$index'),
                          label: 'Amount',
                          controller: _otherCharges[index].amountController,
                        ),
                      ),
                      IconButton(
                        tooltip: 'Remove other charge ${index + 1}',
                        onPressed: () {
                          setState(() {
                            _otherCharges.removeAt(index).dispose();
                          });
                        },
                        icon: const Icon(Icons.delete_outline),
                      ),
                    ],
                  ),
                ),
              const Divider(height: 24),
              Row(
                children: [
                  const Expanded(child: Text('Subtotal / total preview')),
                  Text(
                    _previewTotal == null ? '—' : formatPaise(_previewTotal!),
                    key: const Key('draft-total-preview'),
                    style: const TextStyle(fontWeight: FontWeight.bold),
                  ),
                ],
              ),
              const Text(
                'The backend recalculates and validates the total when finalized.',
                style: TextStyle(fontSize: 12, color: Colors.black54),
              ),
              if (_errorText != null) ...[
                const SizedBox(height: 8),
                Text(_errorText!, style: const TextStyle(color: Colors.red)),
              ],
              const SizedBox(height: 16),
              ElevatedButton(
                key: const Key('save-draft'),
                onPressed: _isSaving ? null : _saveDraft,
                child: _isSaving
                    ? const SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Text('Save draft'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
