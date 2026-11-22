/**
 * dsh-quick-connect type declarations (minimal surface for host consumers).
 */
export declare const name: string;
export declare const inject: string[];
export declare const QUICK_STATUS_PATH: string;
export declare const QUICK_ACTION_PATH: string;

export interface QuickModelRow {
	id: "fast" | "balanced" | "smart" | "advanced";
	name: string;
	description: string;
	input: string[];
	reasoning: boolean;
}

export interface QuickStatusDocument {
	plugin: { name: string; version: string };
	provider: { id: string; displayName: string };
	status: {
		status: "signed-in" | "signed-out" | "error";
		email?: string;
		displayName?: string;
		role?: string;
		profileId?: string;
		tenantUrl?: string;
		tokenExpiresAt?: string;
		message?: string;
	};
	usage:
		| {
				session: { used: number; limit: number; percent: number; resetsAt?: string };
				monthly: { used: number; limit: number; percent: number; resetsAt?: string };
				subscription?: string;
				checkedAt?: string;
				error?: string;
		  }
		| { unavailable: true; error?: string };
	catalog: { shown: boolean; count: number };
	models: Array<{ id: string; name: string; reasoning: boolean }>;
	tenantUrl?: string;
	tenantUrlOverride?: string;
	message?: string;
}

export declare function apply(ctx: unknown, config: unknown): void;
export declare const Config: unknown;
