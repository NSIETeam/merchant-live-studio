export interface AdmissionCheck {
  enforced: boolean;
  ready: boolean;
  checks: { code: string; label: string; passed: boolean; detail: string }[];
  basis: {
    disclosureVersion: number | null;
    courseId: string | null;
    scriptVersion: number | null;
  };
}
