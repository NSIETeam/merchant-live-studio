export interface PlatformComplianceData {
  operatorName: string;
  creditCode: string;
  address: string;
  contact: string;
  complaintContact: string;
  privacyContact: string;
  effectiveDate: string;
  privacyPolicyUrl: string;
  serviceTermsUrl: string;
}

export interface RetentionPolicyData {
  effectiveDate: string;
  liveContentDays: number;
  commerceRecordsMonths: number;
  securityLogsMonths: number;
  deletionReviewContact: string;
}

export interface RetentionStatus {
  configured: boolean;
  data: RetentionPolicyData | null;
  enforcement: string[];
  sourceLinks: Array<{ label: string; url: string }>;
}

export interface PlatformComplianceResponse {
  configured: boolean;
  data: PlatformComplianceData | null;
  dataPractices: string[];
  retention: RetentionStatus;
}
