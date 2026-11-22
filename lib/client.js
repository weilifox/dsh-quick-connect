window.__ModuleLoader__.load({
	id: "dsh-quick-connect",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");
		const h = react.createElement;

		/** Plugin-owned routes (kept in sync with lib/index.js). */
		const QUICK_STATUS_PATH = "/plugins/dsh-quick-connect/status";
		const QUICK_ACTION_PATH = "/plugins/dsh-quick-connect/action";
		const POLL_INTERVAL_MS = 60_000;

		const zh = {
			title: "Amazon Quick",
			subtitle: "复用 Quick 桌面端登录 · {count} 个档位",
			loading: "读取中…",
			signedIn: "已登录",
			signedOut: "未登录",
			unreadable: "读取失败",
			account: "账号",
			subscription: "订阅",
			sessionUsage: "本次会话用量",
			monthlyUsage: "本月用量",
			usedOf: "{used} / {limit} 分钟",
			models: "档位",
			tierNote: "档位即消耗规则：Fast 最省时长，Advanced 最快；每次发送按所选档位路由",
			refresh: "刷新状态",
			refreshUsage: "刷新用量",
			readFailed: "读取状态失败",
			requestFailed: "请求失败",
			hint: "打开一次 Quick 桌面端完成登录；本插件只读凭据，不影响 Quick",
			noUsage: "用量暂不可用",
			unknown: "—"
		};
		const en = {
			title: "Amazon Quick",
			subtitle: "Reuses the Quick desktop sign-in · {count} tiers",
			loading: "Loading…",
			signedIn: "Signed in",
			signedOut: "Signed out",
			unreadable: "Unreadable",
			account: "Account",
			subscription: "Subscription",
			sessionUsage: "Session usage",
			monthlyUsage: "Monthly usage",
			usedOf: "{used} / {limit} min",
			models: "Tiers",
			tierNote: "Tiers are the burn rule: Fast is cheapest, Advanced burns fastest; each send routes by the selected tier",
			refresh: "Refresh",
			refreshUsage: "Refresh usage",
			readFailed: "Failed to read status",
			requestFailed: "Request failed",
			hint: "Open the Quick desktop app once to sign in; this plugin only reads credentials",
			noUsage: "Usage unavailable",
			unknown: "—"
		};

		const cardStyle = {
			overflow: "hidden",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: 10,
			background: "var(--dsw-alias-bg-module-platform)"
		};
		const headerStyle = {
			boxSizing: "border-box",
			width: "100%",
			display: "flex",
			alignItems: "center",
			justifyContent: "space-between",
			gap: 16,
			border: 0,
			padding: "13px 14px",
			background: "transparent",
			color: "var(--dsw-alias-label-primary)",
			font: "inherit",
			textAlign: "left",
			cursor: "pointer"
		};
		const headTextStyle = { display: "flex", minWidth: 0, flexDirection: "column", gap: 3 };
		const nameStyle = { fontSize: 14, lineHeight: "20px", fontWeight: 600 };
		const descriptionStyle = { fontSize: 13, lineHeight: "18px", color: "var(--dsw-alias-label-tertiary)" };
		const bodyStyle = {
			display: "flex",
			flexDirection: "column",
			gap: 10,
			borderTop: "1px solid var(--dsw-alias-border-l2)",
			padding: "12px 14px 14px"
		};
		const rowStyle = { display: "flex", gap: 12, fontSize: 13, lineHeight: "20px" };
		const rowLabelStyle = { flex: "0 0 96px", color: "var(--dsw-alias-label-tertiary)" };
		const rowValueStyle = { flex: "1 1 0", minWidth: 0, color: "var(--dsw-alias-label-primary)", overflowWrap: "anywhere" };
		const chipRowStyle = { display: "flex", flexWrap: "wrap", gap: 6 };
		const chipStyle = {
			fontSize: 12,
			lineHeight: "18px",
			padding: "1px 8px",
			borderRadius: 999,
			border: "1px solid var(--dsw-alias-border-l2)",
			color: "var(--dsw-alias-label-secondary)"
		};
		const buttonStyle = {
			alignSelf: "flex-start",
			font: "inherit",
			fontSize: 13,
			padding: "5px 12px",
			borderRadius: 8,
			border: "1px solid var(--dsw-alias-border-l2)",
			background: "var(--dsw-alias-bg-module-platform)",
			color: "var(--dsw-alias-label-primary)",
			cursor: "pointer"
		};
		const noticeStyle = { fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-state-error-primary, #d92d20)" };
		const hintStyle = { fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-label-tertiary)" };
		const barTrackStyle = {
			flex: "1 1 0",
			height: 6,
			borderRadius: 999,
			background: "var(--dsw-alias-bg-module-hover, rgba(127,127,127,0.18))",
			overflow: "hidden"
		};
		const barFillStyle = (percent) => ({
			height: "100%",
			width: `${Math.max(0, Math.min(100, percent))}%`,
			borderRadius: 999,
			background:
				percent >= 80
					? "var(--dsw-alias-state-error-primary, #d92d20)"
					: percent >= 60
						? "var(--dsw-alias-state-warning-primary, #d9822b)"
						: "var(--dsw-alias-state-success-primary, #22a06b)"
		});

		function dotColor(status) {
			if (status === "signed-in") return "var(--dsw-alias-state-success-primary, #22a06b)";
			if (status === "error") return "var(--dsw-alias-state-error-primary, #d92d20)";
			return "var(--dsw-alias-label-dimmed, #9aa0a6)";
		}

		function isStatusDocument(value) {
			if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
			const inner = value["status"];
			return typeof inner === "object" && inner !== null && typeof inner["status"] === "string";
		}

		function formatWhen(iso) {
			if (typeof iso !== "string" || iso.length === 0) return undefined;
			const when = new Date(iso);
			if (Number.isNaN(when.getTime())) return undefined;
			return when.toLocaleString();
		}

		function Row({ label, value }) {
			return h("div", { style: rowStyle }, [
				h("span", { key: "l", style: rowLabelStyle }, label),
				h("span", { key: "v", style: rowValueStyle }, value)
			]);
		}

		function UsageRow({ label, bucket, t }) {
			if (!bucket || typeof bucket.used !== "number" || typeof bucket.limit !== "number") return null;
			const percent = typeof bucket.percent === "number" ? bucket.percent : Math.round((bucket.used / Math.max(1, bucket.limit)) * 100);
			const resets = formatWhen(bucket.resetsAt);
			const text = t("usedOf", { used: String(bucket.used), limit: String(bucket.limit) });
			return h("div", { style: rowStyle, key: label }, [
				h("span", { style: { ...rowLabelStyle, flexBasis: 96 } }, label),
				h("span", { style: { ...rowValueStyle, display: "flex", alignItems: "center", gap: 10 } }, [
					h("span", { style: { flex: "0 0 auto" } }, text + (resets ? ` · ${resets}` : "")),
					h("span", { style: barTrackStyle }, h("span", { style: barFillStyle(percent) }))
				])
			]);
		}

		function QuickPluginCard(props) {
			const { t } = props;
			const [open, setOpen] = react.useState(false);
			const [doc, setDoc] = react.useState();
			const [failure, setFailure] = react.useState();
			const [busy, setBusy] = react.useState(false);
			const mounted = react.useRef(true);

			react.useEffect(() => {
				mounted.current = true;
				return () => {
					mounted.current = false;
				};
			}, []);

			const refresh = react.useCallback(async (signal) => {
				try {
					const response = await fetch(QUICK_STATUS_PATH, {
						headers: { accept: "application/json" },
						credentials: "same-origin",
						...(signal === undefined ? {} : { signal })
					});
					const value = await response.json().catch(() => undefined);
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					if (!isStatusDocument(value)) throw new Error(t("readFailed"));
					if (!mounted.current || signal?.aborted === true) return;
					setDoc(value);
					setFailure(undefined);
				} catch (error) {
					if (!mounted.current || signal?.aborted === true) return;
					setFailure(error instanceof Error ? error.message : t("requestFailed"));
				}
			}, [t]);

			react.useEffect(() => {
				if (!open) return undefined;
				const controller = new AbortController();
				refresh(controller.signal);
				return () => controller.abort();
			}, [open, refresh]);

			const inner = doc?.status;
			const innerStatus = typeof inner === "object" && inner !== null ? inner["status"] : undefined;
			react.useEffect(() => {
				if (!open || innerStatus !== "signed-in") return undefined;
				const controller = new AbortController();
				const timer = window.setInterval(() => refresh(controller.signal), POLL_INTERVAL_MS);
				return () => {
					window.clearInterval(timer);
					controller.abort();
				};
			}, [open, innerStatus, refresh]);

			const trigger = async () => {
				setBusy(true);
				try {
					await fetch(QUICK_ACTION_PATH, {
						method: "POST",
						headers: { "content-type": "application/json" },
						credentials: "same-origin",
						body: JSON.stringify({ action: "refresh" })
					});
				} catch {
					/* the refreshed document carries the reason */
				}
				await refresh();
				if (mounted.current) setBusy(false);
			};

			const stateLabel = innerStatus === "signed-in" ? t("signedIn") : innerStatus === "error" ? t("unreadable") : innerStatus === "signed-out" ? t("signedOut") : t("loading");
			const count = typeof doc?.catalog?.count === "number" ? doc.catalog.count : 0;
			const subtitle = t("subtitle", { count: String(count) });

			const rows = [];
			if (typeof inner === "object" && inner !== null) {
				const email = inner["email"];
				const displayName = inner["displayName"];
				const account = [displayName, email].filter((part) => typeof part === "string" && part.length > 0).join(" · ");
				rows.push(
					h(Row, {
						key: "account",
						label: t("account"),
						value: account.length > 0 ? account : t("unknown")
					})
				);
				const subscription = typeof doc?.usage?.subscription === "string" ? doc.usage.subscription : undefined;
				if (subscription !== undefined) rows.push(h(Row, { key: "sub", label: t("subscription"), value: subscription }));
			}
			const usage = doc?.usage;
			if (usage && usage.session && usage.monthly) {
				rows.push(
					h(UsageRow, { key: "session", label: t("sessionUsage"), bucket: usage.session, t }),
					h(UsageRow, { key: "monthly", label: t("monthlyUsage"), bucket: usage.monthly, t })
				);
			} else if (usage?.error) {
				rows.push(h("div", { key: "uerr", style: noticeStyle }, `${t("noUsage")}: ${usage.error}`));
			}

			const models = Array.isArray(doc?.models) ? doc.models : [];
			const hint = innerStatus === "signed-out" ? t("hint") : t("tierNote");
			const message = typeof doc?.message === "string" ? doc.message : undefined;

			return h("div", { style: cardStyle }, [
				h("button", {
					key: "head",
					type: "button",
					style: headerStyle,
					onClick: () => setOpen((value) => !value),
					"aria-expanded": open
				}, [
					h("span", { key: "text", style: headTextStyle }, [
						h("span", { key: "name", style: nameStyle }, [
							h("span", {
								key: "dot",
								style: {
									display: "inline-block",
									width: 8,
									height: 8,
									marginRight: 8,
									borderRadius: "50%",
									background: dotColor(innerStatus)
								}
							}),
							t("title")
						]),
						h("span", { key: "desc", style: descriptionStyle }, `${stateLabel} · ${subtitle}`)
					]),
					h("span", { key: "chevron", style: { color: "var(--dsw-alias-label-tertiary)" } }, open ? "▾" : "▸")
				]),
				open
					? h("div", { key: "body", style: bodyStyle }, [
							...rows,
							models.length > 0
								? h("div", { key: "models", style: chipRowStyle }, models.map((model) => h("span", { key: model.id, style: chipStyle }, model.name ?? model.id)))
								: null,
							message !== undefined ? h("div", { key: "message", style: noticeStyle }, message) : null,
							hint !== undefined ? h("div", { key: "hint", style: hintStyle }, hint) : null,
							failure !== undefined ? h("div", { key: "failure", style: noticeStyle }, failure) : null,
							h("button", { key: "refresh", type: "button", style: buttonStyle, disabled: busy, onClick: trigger }, busy ? t("loading") : t("refreshUsage"))
						])
					: null
			]);
		}

		const name = "dsh-quick-connect-client";
		const inject = ["slots", "locale"];

		function apply(ctx) {
			try {
				const namespace = "settings.quick";
				ctx.effect(() => ctx.locale.register(namespace, { zh, en }), "dsh-quick-connect: settings copy");
				const t = ctx.locale.bind(namespace);
				const SETTINGS_TAB_SLOT = "settings.plugins.tab";
				const register = ctx.slots.register;
				ctx.slots.inject(SETTINGS_TAB_SLOT, () => register({
					name: SETTINGS_TAB_SLOT,
					key: "quick",
					priority: 30,
					inject: () => ({ t })
				}, QuickPluginCard));
			} catch (error) {
				console.error("[dsh-quick-connect] client card failed to load (host provider unaffected):", error);
			}
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
