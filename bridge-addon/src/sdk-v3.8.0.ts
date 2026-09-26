// Minimal compile-time surface copied from Wealthfolio v3.8.0 SDK contracts at
// commit 8f6f9898d30e84d7215e01d3d06cd65e02c9ab1b. The host supplies the runtime.
export interface HostAccount {
  id: string;
  name: string;
  currency: string;
  isActive: boolean;
  isArchived: boolean;
}

export interface HostActivity {
  id: string;
  accountId: string;
  activityType: string;
  amount?: string | null;
  currency: string;
  date?: Date;
  activityDate?: string;
  comment?: string;
}

export interface ActivityCreate {
  id?: string;
  accountId: string;
  activityType: string;
  activityDate: string | Date;
  amount?: string | number | null;
  currency?: string;
  status?: "POSTED" | "PENDING" | "DRAFT" | "VOID";
  needsReview?: boolean;
  comment?: string | null;
}

export interface AddonContext {
  router: {
    add(route: { id: string; path: string; component: () => unknown }): void;
  };
  onDisable(callback: () => void): void;
  api: {
    accounts: { getAll(): Promise<HostAccount[]> };
    activities: {
      getAll(accountId?: string): Promise<HostActivity[]>;
      create(activity: ActivityCreate): Promise<{ id: string }>;
    };
    network: {
      request(request: {
        url: string;
        method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
        headers?: Record<string, string>;
        body?: string;
        auth?: { type: "bearer" | "basic"; secretKey: string };
      }): Promise<{ status: number; headers: Record<string, string>; body: string }>;
    };
    storage: {
      get(key: string): Promise<string | null>;
      set(key: string, value: string): Promise<void>;
      delete(key: string): Promise<void>;
    };
    secrets: {
      set(key: string, value: string): Promise<void>;
      delete(key: string): Promise<void>;
    };
    logger: { info(message: string): void; warn(message: string): void; error(message: string): void };
    toast: { success(message: string): void; warning(message: string): void; error(message: string): void };
  };
}

export type AddonEnableFunction = (context: AddonContext) => void | Promise<void>;
