import 'package:cloud_functions/cloud_functions.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/material.dart';

import '../../services/landlord_payment_review_repository.dart';
import '../../services/monthly_billing_repository.dart';

class LandlordPaymentReviewScreen extends StatefulWidget {
  const LandlordPaymentReviewScreen({required this.repository, super.key});

  final LandlordPaymentReviewRepository repository;

  @override
  State<LandlordPaymentReviewScreen> createState() =>
      _LandlordPaymentReviewScreenState();
}

class _LandlordPaymentReviewScreenState
    extends State<LandlordPaymentReviewScreen> {
  late Stream<List<LandlordPaymentReview>> _paymentsStream;
  String? _submittingPaymentId;

  @override
  void initState() {
    super.initState();
    _paymentsStream = widget.repository.watchPendingPayments();
  }

  void _refreshQueue() {
    if (!mounted) return;
    setState(() {
      _paymentsStream = widget.repository.watchPendingPayments();
    });
  }

  Future<void> _confirmAcceptance(LandlordPaymentReview payment) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Accept payment?'),
        content: const Text(
          'This will mark the rent charge as paid and notify the tenant.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, false),
            child: const Text('Cancel'),
          ),
          ElevatedButton(
            key: const Key('confirm-payment-accept'),
            onPressed: () => Navigator.pop(dialogContext, true),
            child: const Text('Accept payment'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    await _submitDecision(
      VerifyUpiPaymentRequest(paymentId: payment.paymentId, decision: 'accept'),
    );
  }

  Future<void> _rejectPayment(LandlordPaymentReview payment) async {
    final formKey = GlobalKey<FormState>();
    var reasonCode = upiPaymentRejectionReasons.keys.first;
    var explanation = '';

    final request = await showDialog<VerifyUpiPaymentRequest>(
      context: context,
      builder: (dialogContext) => StatefulBuilder(
        builder: (dialogContext, setDialogState) => AlertDialog(
          title: const Text('Reject payment'),
          content: Form(
            key: formKey,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                DropdownButtonFormField<String>(
                  key: const Key('rejection-reason-dropdown'),
                  initialValue: reasonCode,
                  decoration: const InputDecoration(
                    labelText: 'Rejection reason',
                  ),
                  isExpanded: true,
                  items: upiPaymentRejectionReasons.entries
                      .map(
                        (reason) => DropdownMenuItem(
                          value: reason.key,
                          child: Text(
                            reason.value,
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                      )
                      .toList(),
                  onChanged: (value) {
                    if (value == null) return;
                    setDialogState(() => reasonCode = value);
                  },
                ),
                if (reasonCode == 'other') ...[
                  const SizedBox(height: 12),
                  TextFormField(
                    key: const Key('other-rejection-explanation'),
                    maxLength: 500,
                    maxLines: 3,
                    onChanged: (value) => explanation = value,
                    decoration: const InputDecoration(
                      labelText: 'Explanation',
                      hintText: 'Enter 10-500 characters',
                    ),
                    validator: (value) {
                      final length = value?.trim().length ?? 0;
                      if (length < 10 || length > 500) {
                        return 'Enter 10-500 characters.';
                      }
                      return null;
                    },
                  ),
                ],
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(dialogContext),
              child: const Text('Cancel'),
            ),
            ElevatedButton(
              key: const Key('confirm-payment-rejection'),
              onPressed: () {
                if (reasonCode == 'other' &&
                    !formKey.currentState!.validate()) {
                  return;
                }
                Navigator.pop(
                  dialogContext,
                  VerifyUpiPaymentRequest(
                    paymentId: payment.paymentId,
                    decision: 'reject',
                    rejectionReasonCode: reasonCode,
                    rejectionExplanation: reasonCode == 'other'
                        ? explanation.trim()
                        : null,
                  ),
                );
              },
              child: const Text('Reject payment'),
            ),
          ],
        ),
      ),
    );
    if (request == null || !mounted) return;
    await _submitDecision(request);
  }

  Future<void> _submitDecision(VerifyUpiPaymentRequest request) async {
    if (_submittingPaymentId != null) return;
    setState(() => _submittingPaymentId = request.paymentId);
    try {
      final result = await widget.repository.decidePayment(request);
      if (!mounted) return;
      setState(() {
        _submittingPaymentId = null;
        _paymentsStream = widget.repository.watchPendingPayments();
      });
      final message = result.decision == 'accept'
          ? 'Payment accepted. The rent charge is paid.'
          : 'Payment rejected. The rent charge is ${result.rentChargeStatus}.';
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(message)));
    } catch (error) {
      if (!mounted) return;
      setState(() => _submittingPaymentId = null);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(_actionableError(error)),
          action: SnackBarAction(label: 'Refresh', onPressed: _refreshQueue),
        ),
      );
    }
  }

  void _showProof(LandlordPaymentReview payment) {
    showDialog<void>(
      context: context,
      builder: (context) => Dialog(
        child: InteractiveViewer(
          minScale: 0.5,
          maxScale: 4,
          child: Image.network(
            payment.proofUrl,
            fit: BoxFit.contain,
            errorBuilder: (context, error, stackTrace) => const Padding(
              padding: EdgeInsets.all(24),
              child: Text('Proof image could not be loaded.'),
            ),
          ),
        ),
      ),
    );
  }

  String _actionableError(Object error) {
    if (error is FirebaseFunctionsException) {
      switch (error.code) {
        case 'permission-denied':
          return 'You are not authorized to review this payment.';
        case 'failed-precondition':
        case 'not-found':
          return 'This payment is no longer awaiting review. Refresh the queue.';
        case 'unavailable':
        case 'deadline-exceeded':
          return 'The result is uncertain. Refresh the queue before retrying.';
        case 'unauthenticated':
          return 'Your session expired. Sign in again before reviewing payments.';
        case 'invalid-argument':
          return 'The decision details were rejected. Check them and retry.';
      }
    }
    if (error is FirebaseException) {
      switch (error.code) {
        case 'permission-denied':
          return 'Only the owning landlord can view these payments.';
        case 'unavailable':
        case 'deadline-exceeded':
          return 'Connection failed. Check your internet connection and refresh.';
        case 'unauthenticated':
          return 'Your session expired. Sign in again before reviewing payments.';
      }
    }
    if (error is StateError) return error.message.toString();
    return 'Could not update the payment. Refresh the queue and try again.';
  }

  String _streamError(Object error) {
    if (error is FirebaseFunctionsException ||
        error is FirebaseException ||
        error is StateError) {
      return _actionableError(error);
    }
    return 'Could not load pending payments. Check your connection and retry.';
  }

  String _submittedLabel(DateTime date) {
    final utc = date.toUtc().toIso8601String();
    return '${utc.substring(0, 10)} ${utc.substring(11, 16)} UTC';
  }

  Widget _buildPaymentCard(LandlordPaymentReview payment) {
    final busy = _submittingPaymentId != null;
    return Card(
      key: Key('payment-review-card-${payment.paymentId}'),
      margin: const EdgeInsets.only(bottom: 16),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              payment.tenantName,
              style: Theme.of(context).textTheme.titleLarge,
            ),
            const SizedBox(height: 4),
            Text('${payment.propertyName} • ${payment.roomNumber}'),
            if (payment.leaseStatus == 'ended') const Text('Historical lease'),
            const SizedBox(height: 12),
            Text('Billing month: ${payment.billingMonth}'),
            Text('Amount: ${formatPaise(payment.amountPaise)}'),
            Text('UTR: ${payment.transactionRef}'),
            Text('Submitted: ${_submittedLabel(payment.submittedAt)}'),
            const SizedBox(height: 12),
            Semantics(
              button: true,
              label: 'View payment proof',
              child: InkWell(
                key: Key('payment-proof-image-${payment.paymentId}'),
                onTap: () => _showProof(payment),
                child: Center(
                  child: Image.network(
                    payment.proofUrl,
                    height: 180,
                    width: double.infinity,
                    fit: BoxFit.contain,
                    errorBuilder: (context, error, stackTrace) =>
                        const SizedBox(
                          height: 180,
                          child: Center(
                            child: Text('Proof image could not be loaded.'),
                          ),
                        ),
                  ),
                ),
              ),
            ),
            Align(
              alignment: Alignment.centerLeft,
              child: TextButton.icon(
                key: Key('view-proof-${payment.paymentId}'),
                onPressed: () => _showProof(payment),
                icon: const Icon(Icons.open_in_full),
                label: const Text('View proof'),
              ),
            ),
            const SizedBox(height: 8),
            Row(
              children: [
                Expanded(
                  child: OutlinedButton.icon(
                    key: Key('reject-payment-${payment.paymentId}'),
                    onPressed: busy ? null : () => _rejectPayment(payment),
                    icon: const Icon(Icons.close),
                    label: const Text('Reject'),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: ElevatedButton.icon(
                    key: Key('accept-payment-${payment.paymentId}'),
                    onPressed: busy ? null : () => _confirmAcceptance(payment),
                    icon: _submittingPaymentId == payment.paymentId
                        ? const SizedBox(
                            height: 16,
                            width: 16,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(Icons.check),
                    label: const Text('Accept'),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildQueue() {
    return StreamBuilder<List<LandlordPaymentReview>>(
      stream: _paymentsStream,
      builder: (context, snapshot) {
        if (snapshot.hasError) {
          return Center(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(_streamError(snapshot.error!)),
                const SizedBox(height: 8),
                TextButton.icon(
                  key: const Key('refresh-payment-queue'),
                  onPressed: _refreshQueue,
                  icon: const Icon(Icons.refresh),
                  label: const Text('Refresh queue'),
                ),
              ],
            ),
          );
        }
        if (snapshot.connectionState == ConnectionState.waiting &&
            !snapshot.hasData) {
          return const Center(child: CircularProgressIndicator());
        }
        final payments = (snapshot.data ?? const <LandlordPaymentReview>[])
            .where((payment) => payment.status == 'pending_verification')
            .toList();
        if (payments.isEmpty) {
          return const Center(
            child: Text('No UPI payments are awaiting verification.'),
          );
        }
        return ListView.builder(
          key: const Key('pending-payment-list'),
          padding: const EdgeInsets.only(bottom: 24),
          itemCount: payments.length,
          itemBuilder: (context, index) => _buildPaymentCard(payments[index]),
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  'Pending UPI payments',
                  style: Theme.of(context).textTheme.titleMedium,
                ),
              ),
              IconButton(
                key: const Key('refresh-payment-queue-button'),
                tooltip: 'Refresh payment queue',
                onPressed: _refreshQueue,
                icon: const Icon(Icons.refresh),
              ),
            ],
          ),
          Expanded(child: _buildQueue()),
        ],
      ),
    );
  }
}
