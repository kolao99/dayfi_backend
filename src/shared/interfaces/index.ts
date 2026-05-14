export interface JwtSignature {
  issuer: string;
  subject: string;
  audience: string;
}

export interface SignedData {
  user_id: string;
  email: string;
  first_name?: string;
  last_name?: string;
  status?: string;
  user_type: string;
  role: string;
  permission: string;
  passCheck: string;
}

export interface User {
  user_id: string;
  email?: string;
  first_name?: string;
  last_name?: string;
  status?: string;
  user_type?: string;
}

export interface WebhookData {
  applicantId: string;
  inspectionId: string;
  applicantType?: string;
  correlationId: string;
  levelName: string;
  externalUserId: string;
  type: 'applicantPending' | 'applicantReviewed';
  sandboxMode: string;
  reviewStatus: 'pending' | 'completed';
  createdAtMs: string;
  reviewResult?: {
    reviewAnswer: 'GREEN' | 'RED' | 'GRAY';
  };
  clientId?: string;
}
