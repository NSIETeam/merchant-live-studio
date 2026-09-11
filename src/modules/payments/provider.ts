/** Future provider contract. Never accept OpenID or payment status from an anonymous viewer. */
export interface TransferRequest {
  merchantId: string;
  outBillNo: string;
  amountCents: number;
  verifiedRecipientId: string;
}
export interface TransferReceipt {
  outBillNo: string;
  state: "pending" | "wait_user_confirm" | "paid" | "failed" | "cancelled";
  providerId?: string;
  confirmationPackage?: string;
}
export interface VerifiedTransferEvent {
  eventId: string;
  merchantId: string;
  amountCents: number;
  verifiedRecipientId: string;
  receipt: TransferReceipt;
}
export interface PaymentProvider {
  createTransfer(request: TransferRequest): Promise<TransferReceipt>;
  queryTransfer(
    merchantId: string,
    outBillNo: string,
  ): Promise<TransferReceipt>;
  verifyAndDecodeNotification(
    headers: Record<string, string>,
    rawBody: Uint8Array,
  ): Promise<VerifiedTransferEvent>;
}
/** Explicit fail-closed boundary. Setting WeChat environment values does NOT enable payment. */
export class WeChatPaymentProvider implements PaymentProvider {
  async createTransfer(_request: TransferRequest): Promise<TransferReceipt> {
    throw new Error("WeChat transfer integration is not implemented");
  }
  async queryTransfer(
    _merchantId: string,
    _outBillNo: string,
  ): Promise<TransferReceipt> {
    throw new Error("WeChat transfer integration is not implemented");
  }
  async verifyAndDecodeNotification(
    _headers: Record<string, string>,
    _rawBody: Uint8Array,
  ): Promise<VerifiedTransferEvent> {
    throw new Error("WeChat notification verification is not implemented");
  }
}
