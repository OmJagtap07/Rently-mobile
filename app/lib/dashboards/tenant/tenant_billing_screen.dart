import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';

import '../../services/monthly_billing_repository.dart';
import '../../services/tenant_billing_repository.dart';
import '../../services/property_payment_details.dart';
import '../../services/tenant_payment_submission_service.dart';
import '../../widgets/property_upi_payment_info_card.dart';

class PickedPaymentProof {
  const PickedPaymentProof({required this.name, required this.bytes});

  final String name;
  final Uint8List bytes;
}

typedef PaymentProofPicker = Future<PickedPaymentProof?> Function();

class TenantBillingScreen extends StatefulWidget {
  TenantBillingScreen({
    super.key,
    TenantBillingRepository? repository,
    this.paymentService,
  }) : repository = repository ?? FirestoreTenantBillingRepository();

  final TenantBillingRepository repository;
  final TenantPaymentSubmissionService? paymentService;

  @override
  State<TenantBillingScreen> createState() => _TenantBillingScreenState();
}

class _TenantBillingScreenState extends State<TenantBillingScreen> {
  late Stream<List<TenantRentBill>> _bills;

  @override
  void initState() {
    super.initState();
    _watchBills();
  }

  void _watchBills() {
    _bills = widget.repository.watchTenantBills();
  }

  void _retry() {
    setState(_watchBills);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Rent Bills')),
      body: StreamBuilder<List<TenantRentBill>>(
        stream: _bills,
        builder: (context, snapshot) {
          if (snapshot.hasError) {
            return _BillingErrorState(onRetry: _retry);
          }
          if (snapshot.connectionState == ConnectionState.waiting) {
            return const Center(
              child: CircularProgressIndicator(
                key: Key('tenant-bills-loading'),
              ),
            );
          }

          final bills =
              List<TenantRentBill>.of(snapshot.data ?? const <TenantRentBill>[])
                ..sort((a, b) {
                  final monthComparison = b.billingMonth.compareTo(
                    a.billingMonth,
                  );
                  return monthComparison != 0
                      ? monthComparison
                      : b.id.compareTo(a.id);
                });
          if (bills.isEmpty) {
            return const Center(
              child: Padding(
                padding: EdgeInsets.all(24),
                child: Text(
                  'No finalized bills yet.',
                  key: Key('tenant-bills-empty'),
                  textAlign: TextAlign.center,
                ),
              ),
            );
          }

          return ListView.builder(
            padding: const EdgeInsets.symmetric(vertical: 8),
            itemCount: bills.length,
            itemBuilder: (context, index) => _TenantBillCard(
              bill: bills[index],
              onTap: () => Navigator.of(context).push(
                MaterialPageRoute<void>(
                  builder: (_) => TenantBillDetailsScreen(
                    bill: bills[index],
                    billingRepository: widget.repository,
                    paymentService: widget.paymentService,
                  ),
                ),
              ),
            ),
          );
        },
      ),
    );
  }
}

class _TenantBillCard extends StatelessWidget {
  const _TenantBillCard({required this.bill, required this.onTap});

  final TenantRentBill bill;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Card(
      key: Key('tenant-bill-${bill.id}'),
      margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
      child: ListTile(
        title: Text(
          formatBillingMonth(bill.billingMonth),
          style: const TextStyle(fontWeight: FontWeight.bold),
        ),
        subtitle: Padding(
          padding: const EdgeInsets.only(top: 6),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('Due ${formatBillDate(bill.dueDate)}'),
              const SizedBox(height: 4),
              _BillStatusChip(status: bill.status),
            ],
          ),
        ),
        trailing: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              formatPaise(bill.total),
              style: const TextStyle(fontWeight: FontWeight.bold),
            ),
            const SizedBox(width: 4),
            const Icon(Icons.chevron_right),
          ],
        ),
        onTap: onTap,
      ),
    );
  }
}

class TenantBillDetailsScreen extends StatefulWidget {
  const TenantBillDetailsScreen({
    required this.bill,
    this.billingRepository,
    this.paymentService,
    this.pickPaymentProof,
    super.key,
  });

  final TenantRentBill bill;
  final TenantBillingRepository? billingRepository;
  final TenantPaymentSubmissionService? paymentService;
  final PaymentProofPicker? pickPaymentProof;

  @override
  State<TenantBillDetailsScreen> createState() =>
      _TenantBillDetailsScreenState();
}

class _TenantBillDetailsScreenState extends State<TenantBillDetailsScreen> {
  StreamSubscription<List<TenantRentBill>>? _billSubscription;
  StreamSubscription<String?>? _authSubscription;
  late final TenantPaymentSubmissionService _paymentService;
  String? _authenticatedTenantId;
  TenantRentBill? _authoritativeBill;
  String? _billStatusError;
  String? _billStreamError;
  bool _statusResolved = false;
  bool _submissionConfirmed = false;
  int _refreshGeneration = 0;

  @override
  void initState() {
    super.initState();
    _paymentService =
        widget.paymentService ?? FirebaseTenantPaymentSubmissionService();
    _authenticatedTenantId = _readAuthenticatedTenantId();
    _authSubscription = _paymentService.authenticatedUserChanges.listen(
      _handleAuthenticatedUserChange,
      onError: (Object error, StackTrace stackTrace) =>
          _handleAuthenticatedUserChange(null),
    );
    final repository = widget.billingRepository;
    if (repository != null) {
      _listenForBillUpdates(_authenticatedTenantId);
    } else {
      _billStatusError = 'Could not verify the latest bill status.';
    }
    unawaited(_refreshBillFromServer());
  }

  @override
  void dispose() {
    _authSubscription?.cancel();
    _billSubscription?.cancel();
    super.dispose();
  }

  String? _readAuthenticatedTenantId() {
    try {
      return _paymentService.authenticatedTenantId;
    } on PaymentAttemptStorageException {
      return null;
    } on StateError {
      return null;
    }
  }

  bool _isCurrentTenant(String tenantId) =>
      mounted &&
      _authenticatedTenantId == tenantId &&
      _readAuthenticatedTenantId() == tenantId;

  void _handleAuthenticatedUserChange(String? tenantId) {
    if (!mounted || tenantId == _authenticatedTenantId) return;
    _authenticatedTenantId = tenantId;
    _refreshGeneration++;
    _billSubscription?.cancel();
    _authoritativeBill = null;
    setState(() {
      _statusResolved = false;
      _submissionConfirmed = false;
      _billStatusError = tenantId == null
          ? 'Sign in again to verify this bill.'
          : null;
      _billStreamError = null;
    });
    _listenForBillUpdates(tenantId);
  }

  void _listenForBillUpdates(String? tenantId) {
    final repository = widget.billingRepository;
    if (repository == null || tenantId == null) return;
    _billSubscription = repository.watchTenantBills().listen(
      (_) {
        if (_authenticatedTenantId == tenantId) {
          unawaited(_refreshBillFromServer());
        }
      },
      onError: (Object error, StackTrace stackTrace) {
        if (!mounted || _authenticatedTenantId != tenantId) return;
        setState(
          () => _billStreamError = 'Bill updates are temporarily unavailable.',
        );
        unawaited(_refreshBillFromServer());
      },
    );
  }

  Future<TenantRentBill?> _refreshBillFromServer() async {
    final repository = widget.billingRepository;
    if (repository == null) return null;
    final generation = ++_refreshGeneration;
    final tenantId = _authenticatedTenantId;
    if (tenantId == null || _readAuthenticatedTenantId() != tenantId) {
      if (mounted && generation == _refreshGeneration) {
        setState(() {
          _authoritativeBill = null;
          _statusResolved = false;
          _billStatusError = 'Sign in again to verify this bill.';
        });
      }
      return null;
    }
    try {
      final bill = await repository.fetchTenantBillFromServer(widget.bill.id);
      if (!_isCurrentTenant(tenantId) || generation != _refreshGeneration) {
        final currentTenantId = _readAuthenticatedTenantId();
        if (mounted && currentTenantId != _authenticatedTenantId) {
          _handleAuthenticatedUserChange(currentTenantId);
        }
        return null;
      }
      if (bill == null) {
        setState(() {
          _statusResolved = false;
          _billStatusError = 'This bill is no longer available.';
        });
        return null;
      }
      setState(() {
        _authoritativeBill = bill;
        _statusResolved = true;
        _billStatusError = null;
        _billStreamError = null;
      });
      return bill;
    } on StateError {
      if (!mounted || generation != _refreshGeneration) return null;
      final currentTenantId = _readAuthenticatedTenantId();
      if (currentTenantId != tenantId) {
        _handleAuthenticatedUserChange(currentTenantId);
      } else {
        setState(() {
          _authoritativeBill = null;
          _statusResolved = false;
          _billStatusError = 'Could not verify the latest bill status. Sign in again or retry.';
        });
      }
      return null;
    } on Exception {
      if (!_isCurrentTenant(tenantId) || generation != _refreshGeneration) {
        final currentTenantId = _readAuthenticatedTenantId();
        if (mounted && currentTenantId != _authenticatedTenantId) {
          _handleAuthenticatedUserChange(currentTenantId);
        }
        return null;
      }
      setState(() {
        _authoritativeBill = null;
        _statusResolved = false;
        _billStatusError =
            'Could not verify the latest bill status. Check your connection '
            'and retry.';
      });
      return null;
    }
  }

  void _setSubmissionConfirmed(bool confirmed) {
    final tenantId = _authenticatedTenantId;
    if (tenantId != null && _isCurrentTenant(tenantId)) {
      setState(() => _submissionConfirmed = confirmed);
    }
  }

  @override
  Widget build(BuildContext context) {
    final currentTenantId = _readAuthenticatedTenantId();
    final identityMatches =
        currentTenantId != null && currentTenantId == _authenticatedTenantId;
    return Scaffold(
      appBar: AppBar(title: Text(formatBillingMonth(widget.bill.billingMonth))),
      body: _TenantBillDetailsContent(
        bill: _authoritativeBill ?? widget.bill,
        statusResolved: _statusResolved && identityMatches,
        submissionConfirmed: _submissionConfirmed,
        statusError: !identityMatches
            ? 'Sign in again to verify this bill.'
            : _submissionConfirmed &&
                  _authoritativeBill != null &&
                  const {'due', 'overdue'}.contains(_authoritativeBill!.status)
            ? 'Submission confirmed; waiting for the bill status to refresh.'
            : _billStatusError,
        streamError: _billStreamError,
        refreshBill: _refreshBillFromServer,
        onSubmissionConfirmed: _setSubmissionConfirmed,
        paymentService: _paymentService,
        authenticatedTenantId: _authenticatedTenantId,
        pickPaymentProof: widget.pickPaymentProof ?? _pickPaymentProof,
      ),
    );
  }
}

class _TenantBillDetailsContent extends StatelessWidget {
  const _TenantBillDetailsContent({
    required this.bill,
    required this.statusResolved,
    required this.submissionConfirmed,
    required this.statusError,
    required this.streamError,
    required this.refreshBill,
    required this.onSubmissionConfirmed,
    required this.paymentService,
    required this.authenticatedTenantId,
    required this.pickPaymentProof,
  });

  final TenantRentBill bill;
  final bool statusResolved;
  final bool submissionConfirmed;
  final String? statusError;
  final String? streamError;
  final Future<TenantRentBill?> Function() refreshBill;
  final ValueChanged<bool> onSubmissionConfirmed;
  final TenantPaymentSubmissionService paymentService;
  final String? authenticatedTenantId;
  final PaymentProofPicker pickPaymentProof;

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            const Text('Status'),
            _BillStatusChip(
              status:
                  statusResolved &&
                      (!submissionConfirmed ||
                          const {
                            'payment_pending',
                            'paid',
                          }.contains(bill.status))
                  ? bill.status
                  : 'checking',
            ),
          ],
        ),
        if (!statusResolved || statusError != null || streamError != null) ...[
          const SizedBox(height: 8),
          Text(
            statusError ?? streamError ?? 'Checking the latest bill status...',
            key: const Key('tenant-bill-status-message'),
          ),
          if (!statusResolved)
            TextButton(
              key: const Key('retry-tenant-bill-status'),
              onPressed: () => unawaited(refreshBill()),
              child: const Text('Retry status check'),
            ),
        ],
        const SizedBox(height: 8),
        Text('Due date: ${formatBillDate(bill.dueDate)}'),
        const SizedBox(height: 16),
        Text('Bill breakdown', style: Theme.of(context).textTheme.titleMedium),
        const Text(
          'Line items form the subtotal. Fines and adjustments are shown separately.',
        ),
        const Divider(),
        for (final item in bill.lineItems)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 8),
            child: Row(
              children: [
                Expanded(child: Text(item.label)),
                Text(formatPaise(item.amount)),
              ],
            ),
          ),
        const Divider(),
        _FinancialBreakdownRow(label: 'Subtotal', amount: bill.subtotal),
        _FinancialBreakdownRow(
          label: 'Late fines added',
          amount: bill.lateFineTotal,
        ),
        _FinancialBreakdownRow(
          label: bill.adjustmentTotal < 0
              ? 'Adjustment credit'
              : 'Adjustments added',
          amount: bill.adjustmentTotal,
        ),
        const Divider(),
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            const Text(
              'Total payable',
              style: TextStyle(fontWeight: FontWeight.bold),
            ),
            Text(
              formatPaise(bill.total),
              key: const Key('tenant-bill-total'),
              style: const TextStyle(fontWeight: FontWeight.bold),
            ),
          ],
        ),
        const SizedBox(height: 24),
        _TenantUpiPaymentSection(
          key: ValueKey('${bill.id}:${authenticatedTenantId ?? 'signed-out'}'),
          bill: bill,
          statusResolved: statusResolved,
          onSubmissionConfirmed: onSubmissionConfirmed,
          refreshBill: refreshBill,
          service: paymentService,
          authenticatedTenantId: authenticatedTenantId,
          pickPaymentProof: pickPaymentProof,
        ),
      ],
    );
  }
}

Future<PickedPaymentProof?> _pickPaymentProof() async {
  final image = await ImagePicker().pickImage(source: ImageSource.gallery);
  if (image == null) return null;
  return PickedPaymentProof(name: image.name, bytes: await image.readAsBytes());
}

class _TenantUpiPaymentSection extends StatefulWidget {
  const _TenantUpiPaymentSection({
    required this.bill,
    required this.statusResolved,
    required this.onSubmissionConfirmed,
    required this.refreshBill,
    required this.service,
    required this.authenticatedTenantId,
    required this.pickPaymentProof,
    super.key,
  });

  final TenantRentBill bill;
  final bool statusResolved;
  final ValueChanged<bool> onSubmissionConfirmed;
  final Future<TenantRentBill?> Function() refreshBill;
  final TenantPaymentSubmissionService service;
  final String? authenticatedTenantId;
  final PaymentProofPicker pickPaymentProof;

  @override
  State<_TenantUpiPaymentSection> createState() =>
      _TenantUpiPaymentSectionState();
}

class _TenantUpiPaymentSectionState extends State<_TenantUpiPaymentSection> {
  final _utrController = TextEditingController();
  late final Stream<PropertyPaymentDetails?> _propertyDetails;
  PickedPaymentProof? _proof;
  String? _proofFormat;
  String? _idempotencyKey;
  String? _uploadIntentId;
  String? _validatedUtr;
  String? _lastRejectedUtr;
  String? _confirmedDetailsKey;
  String? _lastDetailsKey;
  String? _errorMessage;
  PaymentSubmissionFailure? _submissionFailure;
  bool _isUploading = false;
  bool _isSubmitting = false;
  bool _proofUploaded = false;
  bool _submissionAttempted = false;
  bool _canEditRejectedUtr = false;
  bool _paymentSubmitted = false;
  bool _attemptLoaded = false;
  bool _reconcilingAttempt = false;
  TenantPaymentSubmissionAttempt? _attempt;
  String? _recoveryError;
  double _uploadProgress = 0;

  bool get _eligibleBill =>
      const {'due', 'overdue'}.contains(widget.bill.status);

  bool _isCurrentTenant() {
    final tenantId = widget.authenticatedTenantId;
    if (!mounted || tenantId == null) return false;
    try {
      return widget.service.authenticatedTenantId == tenantId;
    } on PaymentAttemptStorageException {
      return false;
    } on StateError {
      return false;
    }
  }

  @override
  void initState() {
    super.initState();
    final propertyId = widget.bill.propertyId;
    _propertyDetails = propertyId == null || propertyId.isEmpty
        ? const Stream<PropertyPaymentDetails?>.empty()
        : widget.service.watchPropertyPaymentDetails(propertyId);
    if (widget.authenticatedTenantId == null ||
        propertyId == null ||
        propertyId.isEmpty) {
      _attemptLoaded = true;
    } else {
      unawaited(_restoreSubmissionAttempt());
    }
  }

  @override
  void didUpdateWidget(covariant _TenantUpiPaymentSection oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.statusResolved != widget.statusResolved ||
        oldWidget.bill.status != widget.bill.status) {
      unawaited(_reconcileSubmissionAttempt());
    }
  }

  @override
  void dispose() {
    _utrController.dispose();
    super.dispose();
  }

  String _fingerprint(PropertyPaymentDetails details) =>
      '${details.upiId}\u0000${details.upiQrImageUrl}\u0000'
      '${details.upiDisplayName}';

  Future<void> _restoreSubmissionAttempt() async {
    if (!_isCurrentTenant()) {
      if (mounted) setState(() => _attemptLoaded = true);
      return;
    }
    try {
      final attempt = await widget.service.loadSubmissionAttempt(
        widget.bill.id,
      );
      if (!_isCurrentTenant()) return;
      setState(() {
        _attempt = attempt;
        _recoveryError = null;
        if (attempt != null) {
          _uploadIntentId = attempt.uploadIntentId;
          _validatedUtr = attempt.transactionRef;
          _utrController.text = attempt.transactionRef;
          _proofUploaded = true;
          _submissionAttempted =
              attempt.state != PaymentSubmissionAttemptState.proofUploaded;
          _paymentSubmitted =
              attempt.state == PaymentSubmissionAttemptState.submitted;
        }
        _attemptLoaded = true;
      });
      widget.onSubmissionConfirmed(
        attempt?.state == PaymentSubmissionAttemptState.submitted,
      );
      await _reconcileSubmissionAttempt();
    } on Exception {
      if (!_isCurrentTenant()) return;
      setState(() {
        _attemptLoaded = true;
        _recoveryError =
            'Could not restore the saved payment attempt. Check your secure '
            'storage and retry.';
      });
    }
  }

  Future<void> _reconcileSubmissionAttempt() async {
    final attempt = _attempt;
    if (!_attemptLoaded ||
        !widget.statusResolved ||
        attempt == null ||
        _reconcilingAttempt) {
      return;
    }
    _reconcilingAttempt = true;
    try {
      if (const {'payment_pending', 'paid'}.contains(widget.bill.status)) {
        await widget.service.clearSubmissionAttempt(
          expectedTenantId: attempt.tenantId,
          rentChargeId: widget.bill.id,
        );
        if (!_isCurrentTenant()) return;
        setState(() {
          _attempt = null;
          _paymentSubmitted = true;
          _recoveryError = null;
        });
        widget.onSubmissionConfirmed(false);
      } else if (const {'due', 'overdue'}.contains(widget.bill.status) &&
          attempt.state == PaymentSubmissionAttemptState.submitting) {
        final recovered = await widget.service.saveSubmissionAttempt(
          expectedTenantId: attempt.tenantId,
          rentChargeId: attempt.rentChargeId,
          uploadIntentId: attempt.uploadIntentId,
          transactionRef: attempt.transactionRef,
          idempotencyKey: attempt.idempotencyKey,
          state: PaymentSubmissionAttemptState.uncertain,
        );
        if (!_isCurrentTenant()) return;
        setState(() {
          _attempt = recovered;
          _paymentSubmitted = false;
          _submissionAttempted = true;
          _recoveryError = null;
        });
        widget.onSubmissionConfirmed(false);
      }
    } on Exception {
      if (!_isCurrentTenant()) return;
      setState(() {
        _recoveryError =
            'Could not reconcile this payment attempt with the bill. '
            'Payment actions are paused until status can be confirmed.';
      });
    } finally {
      _reconcilingAttempt = false;
    }
  }

  Future<void> _selectProof() async {
    if (!_isCurrentTenant()) return;
    setState(() {
      _errorMessage = null;
    });
    try {
      final selected = await widget.pickPaymentProof();
      if (!_isCurrentTenant() || selected == null) return;
      if (selected.bytes.isEmpty) {
        _setSelectionError('The selected image is empty.');
        return;
      }
      if (selected.bytes.length > maxPaymentProofBytes) {
        _setSelectionError('Choose an image no larger than 5 MB.');
        return;
      }
      final format = detectPaymentProofFormat(selected.bytes);
      if (format == null) {
        _setSelectionError('Choose a JPG, PNG, or WebP image.');
        return;
      }
      setState(() {
        _proof = selected;
        _proofFormat = format;
        _idempotencyKey = null;
        _uploadIntentId = null;
        _validatedUtr = null;
        _submissionFailure = null;
        _proofUploaded = false;
        _submissionAttempted = false;
        _canEditRejectedUtr = _lastRejectedUtr != null;
        _paymentSubmitted = false;
        _uploadProgress = 0;
      });
    } on Exception {
      if (!_isCurrentTenant()) return;
      _setSelectionError('Could not select the image. Please try again.');
    }
  }

  void _setSelectionError(String message) {
    setState(() {
      _errorMessage = message;
      _proof = null;
      _proofFormat = null;
    });
  }

  Future<void> _uploadProof(String detailsKey) async {
    final proof = _proof;
    final format = _proofFormat;
    if (proof == null ||
        format == null ||
        _isUploading ||
        _isSubmitting ||
        _proofUploaded) {
      return;
    }
    if (!_isCurrentTenant()) return;
    _utrController.text = _utrController.text.trim();
    setState(() {
      _isUploading = true;
      _errorMessage = null;
      _uploadProgress = 0;
      _idempotencyKey ??= createPaymentUploadIdempotencyKey();
    });
    try {
      final uploadTenantId = widget.service.authenticatedTenantId;
      final permission = await widget.service.prepareProofUpload(
        rentChargeId: widget.bill.id,
        idempotencyKey: _idempotencyKey!,
        format: format,
        bytes: proof.bytes.length,
      );
      if (!_isCurrentTenant()) return;
      await widget.service.uploadProof(
        permission: permission,
        bytes: proof.bytes,
        format: format,
        onProgress: (sent, total) {
          if (!_isCurrentTenant() || total <= 0) return;
          setState(() => _uploadProgress = sent / total);
        },
      );
      if (!_isCurrentTenant()) return;
      final normalizedUtr = normalizeUtrReference(_utrController.text);
      final submissionKey = createPaymentUploadIdempotencyKey();
      late final TenantPaymentSubmissionAttempt attempt;
      try {
        attempt = await widget.service.saveSubmissionAttempt(
          expectedTenantId: uploadTenantId,
          rentChargeId: widget.bill.id,
          uploadIntentId: permission.uploadIntentId,
          transactionRef: normalizedUtr,
          idempotencyKey: submissionKey,
          state: PaymentSubmissionAttemptState.proofUploaded,
        );
      } on Exception {
        if (!_isCurrentTenant()) return;
        setState(() {
          _recoveryError =
              'The proof uploaded, but its recovery data could not be saved '
              'securely. Retry the upload before submitting.';
          _errorMessage = _recoveryError;
        });
        return;
      }
      if (!_isCurrentTenant()) return;
      setState(() {
        _proofUploaded = true;
        _uploadIntentId = permission.uploadIntentId;
        _validatedUtr = normalizedUtr;
        _utrController.text = normalizedUtr;
        _attempt = attempt;
        _attemptLoaded = true;
        _recoveryError = null;
        _canEditRejectedUtr = false;
        _submissionFailure = null;
        _errorMessage = null;
        _uploadProgress = 1;
      });
    } on PaymentUploadException catch (error) {
      if (!_isCurrentTenant()) return;
      setState(() {
        _errorMessage = '${error.message} You can retry the upload.';
      });
    } on Exception {
      if (!_isCurrentTenant()) return;
      setState(() {
        _errorMessage = 'Proof upload failed. Check your connection and retry.';
      });
    } finally {
      if (_isCurrentTenant()) setState(() => _isUploading = false);
    }
  }

  void _onUtrChanged(String value) {
    setState(() {
      if (_canEditRejectedUtr) {
        _validatedUtr = normalizeUtrReference(value);
        _submissionAttempted = false;
        _submissionFailure = null;
        _errorMessage = null;
      }
    });
  }

  Future<void> _submitPayment(bool recipientConfirmed) async {
    final attempt = _attempt;
    final transactionRef = attempt?.transactionRef ?? _validatedUtr;
    if (_isSubmitting ||
        _paymentSubmitted ||
        !_proofUploaded ||
        attempt == null ||
        !_attemptLoaded ||
        !widget.statusResolved ||
        _recoveryError != null ||
        transactionRef == null ||
        !recipientConfirmed ||
        validateUtrReference(transactionRef) != null ||
        (_lastRejectedUtr != null &&
            normalizeUtrReference(transactionRef) == _lastRejectedUtr)) {
      return;
    }
    if (!_isCurrentTenant()) return;

    setState(() {
      _isSubmitting = true;
      _submissionAttempted = true;
      _canEditRejectedUtr = false;
      _submissionFailure = null;
      _errorMessage = null;
    });
    try {
      final authoritativeBill = await widget.refreshBill();
      if (!_isCurrentTenant()) return;
      if (authoritativeBill == null) {
        setState(() {
          _recoveryError =
              'Could not verify the bill status. Retry the status check before '
              'submitting.';
        });
        return;
      }
      if (!const {'due', 'overdue'}.contains(authoritativeBill.status)) {
        setState(() {
          _submissionFailure = PaymentSubmissionFailure.billIneligible;
          _errorMessage = 'This bill is no longer due or overdue and cannot accept payment.';
        });
        return;
      }
      final storedAttempt = await widget.service.loadSubmissionAttempt(
        widget.bill.id,
      );
      if (!_isCurrentTenant()) return;
      if (storedAttempt == null ||
          storedAttempt.tenantId != attempt.tenantId ||
          storedAttempt.rentChargeId != attempt.rentChargeId ||
          storedAttempt.uploadIntentId != attempt.uploadIntentId ||
          storedAttempt.transactionRef != attempt.transactionRef ||
          storedAttempt.idempotencyKey != attempt.idempotencyKey) {
        setState(() {
          _recoveryError =
              'This saved attempt is not available for the current account. '
              'Reload the bill before trying again.';
        });
        return;
      }
      final submittingAttempt = await widget.service.saveSubmissionAttempt(
        expectedTenantId: attempt.tenantId,
        rentChargeId: attempt.rentChargeId,
        uploadIntentId: attempt.uploadIntentId,
        transactionRef: attempt.transactionRef,
        idempotencyKey: attempt.idempotencyKey,
        state: PaymentSubmissionAttemptState.submitting,
      );
      if (!_isCurrentTenant()) return;
      setState(() => _attempt = submittingAttempt);
      await widget.service.submitPayment(
        expectedTenantId: attempt.tenantId,
        rentChargeId: widget.bill.id,
        uploadIntentId: attempt.uploadIntentId,
        transactionRef: transactionRef,
        idempotencyKey: attempt.idempotencyKey,
      );
      if (!_isCurrentTenant()) return;
      setState(() {
        _paymentSubmitted = true;
        _submissionFailure = null;
      });
      widget.onSubmissionConfirmed(true);
      try {
        final submittedAttempt = await widget.service.saveSubmissionAttempt(
          expectedTenantId: attempt.tenantId,
          rentChargeId: attempt.rentChargeId,
          uploadIntentId: attempt.uploadIntentId,
          transactionRef: attempt.transactionRef,
          idempotencyKey: attempt.idempotencyKey,
          state: PaymentSubmissionAttemptState.submitted,
        );
        if (_isCurrentTenant()) setState(() => _attempt = submittedAttempt);
      } on Exception {
        if (_isCurrentTenant()) {
          setState(() {
            _recoveryError =
                'Payment submission was confirmed, but local recovery state '
                'could not be updated. Bill status is being refreshed.';
          });
        }
      }
      unawaited(widget.refreshBill());
    } on PaymentSubmissionException catch (error) {
      if (!_isCurrentTenant()) return;
      if (error.failure == PaymentSubmissionFailure.duplicateUtr ||
          error.failure == PaymentSubmissionFailure.expiredUploadIntent) {
        try {
          await widget.service.clearSubmissionAttempt(
            expectedTenantId: attempt.tenantId,
            rentChargeId: widget.bill.id,
          );
        } on Exception {
          if (_isCurrentTenant()) {
            setState(() {
              _recoveryError =
                  'The previous attempt could not be invalidated securely. '
                  'Do not retry it; refresh the bill and try again.';
              _errorMessage = _recoveryError;
            });
          }
          return;
        }
      } else if (error.failure != PaymentSubmissionFailure.billIneligible) {
        try {
          final uncertainAttempt = await widget.service.saveSubmissionAttempt(
            expectedTenantId: attempt.tenantId,
            rentChargeId: attempt.rentChargeId,
            uploadIntentId: attempt.uploadIntentId,
            transactionRef: attempt.transactionRef,
            idempotencyKey: attempt.idempotencyKey,
            state: PaymentSubmissionAttemptState.uncertain,
          );
          if (_isCurrentTenant()) setState(() => _attempt = uncertainAttempt);
        } on Exception {
          if (_isCurrentTenant()) {
            setState(() {
              _recoveryError =
                  'The submission result is uncertain and could not be '
                  'saved. Do not start a new attempt; retry status recovery.';
            });
          }
        }
      }
      if (!_isCurrentTenant()) return;
      setState(() {
        _errorMessage = error.failure == PaymentSubmissionFailure.duplicateUtr
            ? '${error.message} Select and upload a new screenshot before '
                  'trying a corrected reference.'
            : error.message;
        _submissionFailure = error.failure;
        switch (error.failure) {
          case PaymentSubmissionFailure.expiredUploadIntent:
            _attempt = null;
            _proofUploaded = false;
            _uploadIntentId = null;
            _validatedUtr = null;
            _idempotencyKey = null;
            _submissionAttempted = false;
            _canEditRejectedUtr = false;
            _recoveryError = null;
            widget.onSubmissionConfirmed(false);
          case PaymentSubmissionFailure.duplicateUtr:
            _attempt = null;
            _lastRejectedUtr = normalizeUtrReference(transactionRef);
            _proof = null;
            _proofFormat = null;
            _proofUploaded = false;
            _uploadIntentId = null;
            _validatedUtr = null;
            _submissionAttempted = false;
            _canEditRejectedUtr = true;
            _recoveryError = null;
            widget.onSubmissionConfirmed(false);
          case PaymentSubmissionFailure.billIneligible:
          case PaymentSubmissionFailure.network:
          case PaymentSubmissionFailure.other:
            break;
        }
      });
      if (error.failure == PaymentSubmissionFailure.billIneligible) {
        unawaited(widget.refreshBill());
      }
    } on Exception {
      if (!_isCurrentTenant()) return;
      try {
        final uncertainAttempt = await widget.service.saveSubmissionAttempt(
          expectedTenantId: attempt.tenantId,
          rentChargeId: attempt.rentChargeId,
          uploadIntentId: attempt.uploadIntentId,
          transactionRef: attempt.transactionRef,
          idempotencyKey: attempt.idempotencyKey,
          state: PaymentSubmissionAttemptState.uncertain,
        );
        if (_isCurrentTenant()) setState(() => _attempt = uncertainAttempt);
      } on Exception {
        if (_isCurrentTenant()) {
          setState(() {
            _recoveryError =
                'The submission result is uncertain and could not be saved. '
                'Do not start a new attempt; retry status recovery.';
          });
        }
      }
      if (!_isCurrentTenant()) return;
      setState(() {
        _errorMessage =
            'Could not confirm payment submission. Retry; the same request '
            'key will be reused.';
        _submissionFailure = PaymentSubmissionFailure.network;
      });
    } finally {
      if (_isCurrentTenant()) setState(() => _isSubmitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (!_isCurrentTenant()) {
      return const _PaymentDetailsUnavailable(
        message: 'Sign in again to continue with payment.',
      );
    }
    if (!_attemptLoaded) {
      return const Padding(
        padding: EdgeInsets.all(16),
        child: Center(
          child: CircularProgressIndicator(
            key: Key('payment-attempt-restoring'),
          ),
        ),
      );
    }
    if (!widget.statusResolved) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _PaymentDetailsUnavailable(
            message: _paymentSubmitted
                ? 'Submission confirmed. Bill status is refreshing; this bill '
                      'will not be offered for another payment.'
                : 'Payment actions are paused until the bill status is '
                      'confirmed.',
          ),
          TextButton(
            key: const Key('retry-payment-status'),
            onPressed: () => unawaited(widget.refreshBill()),
            child: const Text('Retry status check'),
          ),
        ],
      );
    }
    if (_recoveryError != null) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _PaymentDetailsUnavailable(message: _recoveryError!),
          TextButton(
            key: const Key('retry-payment-recovery'),
            onPressed: () => unawaited(_restoreSubmissionAttempt()),
            child: const Text('Retry recovery'),
          ),
        ],
      );
    }
    if (_paymentSubmitted) {
      return const Card(
        key: Key('payment-submitted'),
        child: ListTile(
          leading: Icon(Icons.check_circle_outline),
          title: Text('Payment submitted — awaiting landlord verification'),
        ),
      );
    }
    if (!_eligibleBill && !_paymentSubmitted) {
      return const SizedBox.shrink();
    }
    if (widget.bill.propertyId == null || widget.bill.propertyId!.isEmpty) {
      return const _PaymentDetailsUnavailable(
        message: 'Property payment details are unavailable for this bill.',
      );
    }

    return StreamBuilder<PropertyPaymentDetails?>(
      stream: _propertyDetails,
      builder: (context, snapshot) {
        if (snapshot.hasError) {
          return const _PaymentDetailsUnavailable(
            message:
                'Could not load property payment details. Try again later.',
          );
        }
        if (snapshot.connectionState == ConnectionState.waiting) {
          return const Padding(
            padding: EdgeInsets.all(16),
            child: Center(child: CircularProgressIndicator()),
          );
        }
        final details = snapshot.data;
        if (details == null) {
          return const _PaymentDetailsUnavailable(
            message: 'Property UPI payment details are unavailable.',
          );
        }
        final detailsKey = _fingerprint(details);
        if (_lastDetailsKey != detailsKey) {
          _lastDetailsKey = detailsKey;
          _confirmedDetailsKey = null;
        }
        final recipientConfirmed = _confirmedDetailsKey == detailsKey;
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('Pay by UPI', style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 8),
            PropertyUpiPaymentInfoCard(
              key: ValueKey(detailsKey),
              upiId: details.upiId,
              qrImageUrl: details.upiQrImageUrl,
              displayName: details.upiDisplayName,
              onRecipientConfirmed: (confirmed) {
                setState(() {
                  _confirmedDetailsKey = confirmed ? detailsKey : null;
                });
              },
            ),
            if (!_proofUploaded || _canEditRejectedUtr) ...[
              const SizedBox(height: 12),
              TextField(
                key: const Key('payment-utr-input'),
                controller: _utrController,
                enabled:
                    !_isUploading &&
                    (!_submissionAttempted ||
                        _canEditRejectedUtr ||
                        _lastRejectedUtr != null),
                decoration: const InputDecoration(
                  labelText: 'UTR / reference number',
                  helperText: '6–30 letters or numbers',
                  border: OutlineInputBorder(),
                ),
                textCapitalization: TextCapitalization.characters,
                onChanged: _onUtrChanged,
              ),
            ] else if (!_paymentSubmitted) ...[
              const SizedBox(height: 12),
              Text(
                'UTR/reference: $_validatedUtr',
                key: const Key('uploaded-payment-utr'),
              ),
            ],
            if (!_proofUploaded) ...[
              OutlinedButton.icon(
                key: const Key('select-payment-proof'),
                onPressed: _isUploading || _isSubmitting ? null : _selectProof,
                icon: const Icon(Icons.image_outlined),
                label: Text(
                  _proof == null
                      ? 'Select payment screenshot'
                      : 'Replace screenshot',
                ),
              ),
              if (_proof != null) ...[
                const SizedBox(height: 8),
                Text(_proof!.name, key: const Key('payment-proof-file-name')),
                const SizedBox(height: 8),
                ConstrainedBox(
                  constraints: const BoxConstraints(maxHeight: 240),
                  child: Image.memory(
                    Uint8List.fromList(_proof!.bytes),
                    key: const Key('payment-proof-preview'),
                    fit: BoxFit.contain,
                    errorBuilder: (context, error, stackTrace) => const Text(
                      'Preview unavailable. The selected file can still be '
                      'uploaded after validation.',
                    ),
                  ),
                ),
              ],
              if (_isUploading) ...[
                const SizedBox(height: 12),
                LinearProgressIndicator(
                  key: const Key('payment-proof-upload-progress'),
                  value: _uploadProgress,
                ),
                const SizedBox(height: 4),
                Text(
                  'Uploading ${(100 * _uploadProgress).round()}%',
                  textAlign: TextAlign.center,
                ),
              ],
              if (_errorMessage != null)
                Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: Text(
                    _errorMessage!,
                    key: const Key('payment-proof-upload-error'),
                    style: TextStyle(
                      color: Theme.of(context).colorScheme.error,
                    ),
                  ),
                ),
              const SizedBox(height: 12),
              ElevatedButton(
                key: const Key('upload-payment-proof'),
                onPressed:
                    !_isUploading &&
                        !_isSubmitting &&
                        _proof != null &&
                        widget.statusResolved &&
                        _attemptLoaded &&
                        !(_lastRejectedUtr != null &&
                            normalizeUtrReference(_utrController.text) ==
                                _lastRejectedUtr) &&
                        validateUtrReference(_utrController.text) == null &&
                        recipientConfirmed
                    ? () => _uploadProof(detailsKey)
                    : null,
                child: Text(
                  _errorMessage == null ? 'Upload proof' : 'Retry proof upload',
                ),
              ),
            ] else ...[
              const SizedBox(height: 12),
              if (_paymentSubmitted)
                const Card(
                  key: Key('payment-submitted'),
                  child: ListTile(
                    leading: Icon(Icons.check_circle_outline),
                    title: Text(
                      'Payment submitted — awaiting landlord verification',
                    ),
                  ),
                )
              else ...[
                const Card(
                  key: Key('payment-proof-awaiting-submission'),
                  child: ListTile(
                    leading: Icon(Icons.info_outline),
                    title: Text('Proof uploaded — awaiting submission'),
                    subtitle: Text(
                      'This payment has not been submitted to your landlord '
                      'for verification.',
                    ),
                  ),
                ),
                if (_errorMessage != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 8),
                    child: Text(
                      _errorMessage!,
                      key: const Key('payment-submission-error'),
                      style: TextStyle(
                        color: Theme.of(context).colorScheme.error,
                      ),
                    ),
                  ),
                const SizedBox(height: 12),
                ElevatedButton(
                  key: const Key('submit-payment-proof'),
                  onPressed:
                      !_isSubmitting &&
                          widget.statusResolved &&
                          _attemptLoaded &&
                          _recoveryError == null &&
                          _submissionFailure !=
                              PaymentSubmissionFailure.billIneligible &&
                          recipientConfirmed &&
                          _uploadIntentId != null &&
                          _validatedUtr != null &&
                          validateUtrReference(_validatedUtr!) == null &&
                          !(_lastRejectedUtr != null &&
                              _validatedUtr!.toUpperCase() == _lastRejectedUtr)
                      ? () => _submitPayment(recipientConfirmed)
                      : null,
                  child: Text(
                    _isSubmitting
                        ? 'Submitting payment...'
                        : _submissionAttempted
                        ? 'Retry payment submission'
                        : 'Submit payment for verification',
                  ),
                ),
              ],
            ],
          ],
        );
      },
    );
  }
}

class _PaymentDetailsUnavailable extends StatelessWidget {
  const _PaymentDetailsUnavailable({required this.message});

  final String message;

  @override
  Widget build(BuildContext context) => Card(
    child: Padding(padding: const EdgeInsets.all(16), child: Text(message)),
  );
}

class _FinancialBreakdownRow extends StatelessWidget {
  const _FinancialBreakdownRow({required this.label, required this.amount});

  final String label;
  final int amount;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [Text(label), Text(formatPaise(amount))],
      ),
    );
  }
}

class _BillStatusChip extends StatelessWidget {
  const _BillStatusChip({required this.status});

  final String status;

  @override
  Widget build(BuildContext context) {
    final label = switch (status) {
      'payment_pending' => 'Payment pending',
      'paid' => 'Paid',
      'overdue' => 'Overdue',
      'due' => 'Due',
      'checking' => 'Checking',
      'unavailable' => 'Unavailable',
      _ => 'Finalized',
    };
    final color = switch (status) {
      'paid' => Colors.green,
      'overdue' => Colors.red,
      'due' => Colors.orange,
      'payment_pending' => Colors.blue,
      'checking' || 'unavailable' => Colors.grey,
      _ => Colors.grey,
    };

    return Chip(
      label: Text(label),
      visualDensity: VisualDensity.compact,
      backgroundColor: color.withValues(alpha: 0.12),
      labelStyle: TextStyle(color: color.shade800),
      materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
    );
  }
}

class _BillingErrorState extends StatelessWidget {
  const _BillingErrorState({required this.onRetry});

  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Text(
              'Could not load your bills. Check your connection and try again.',
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 12),
            ElevatedButton(
              key: const Key('retry-tenant-bills'),
              onPressed: onRetry,
              child: const Text('Retry'),
            ),
          ],
        ),
      ),
    );
  }
}

String formatBillingMonth(String billingMonth) {
  final parts = billingMonth.split('-');
  final date = DateTime(int.parse(parts[0]), int.parse(parts[1]));
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
  return '${months[date.month - 1]} ${date.year}';
}

String formatBillDate(String dueDate) {
  final date = DateTime.tryParse(dueDate);
  if (date == null) return dueDate;
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  return '${date.day} ${months[date.month - 1]} ${date.year}';
}
