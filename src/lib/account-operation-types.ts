export type AccountKind =
  | "create_client"
  | "create_bidder"
  | "update_client"
  | "update_bidder"
  | "reset_password"
  | "sign_out_bidder"
  | "set_bidder_password";
export type AccountOperation = {
  requestId: string;
  actorId: string;
  targetId: string;
  kind: AccountKind;
  payload: {
    target?: string;
    name?: string;
    email?: string | null;
    workspace?: string;
    rate?: number | null;
    archived?: boolean;
  };
  status: "ready" | "pending" | "completed" | "abandoned";
  authStep: "ready" | "dispatched" | "accepted" | "skipped";
  leaseUntil?: string | null;
  dispatchId?: string;
  disposition?: string | null;
};
export type AccountActionResult = {
  data?: undefined;
  error?: string;
  operation?: AccountOperation;
  requestId?: string;
  notStarted?: boolean;
  requiresPassword?: boolean;
};
