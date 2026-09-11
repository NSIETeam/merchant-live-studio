export interface AdmissionCheck {
  enforced: boolean;
  ready: boolean;
  checks: { code: string; label: string; passed: boolean; detail: string }[];
  basis: {
    platformPolicyEffectiveDate: string | null;
    retentionPolicyEffectiveDate: string | null;
    disclosureVersion: number | null;
    courseId: string | null;
    scriptVersion: number | null;
  };
}
