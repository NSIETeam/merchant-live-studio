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

export interface PlatformComplianceResponse {
  configured: boolean;
  data: PlatformComplianceData | null;
  dataPractices: string[];
}
