import { APIError, type Context } from "better-call";
import { createAuthEndpoint, createAuthMiddleware } from "../call";
import { getDate } from "../../utils/date";
import { deleteSessionCookie, setSessionCookie } from "../../utils/cookies";
import type { Session, User } from "../../db/schema";
import { z } from "zod";
import { getIp } from "../../utils/get-request-ip";
import type {
	BetterAuthOptions,
	InferSession,
	InferUser,
	Prettify,
} from "../../types";

/**
 * Generate a unique key for the request to cache the
 * request for 5 seconds for this specific request.
 *
 * This is to prevent reaching to database if getSession is
 * called multiple times for the same request
 */
function getRequestUniqueKey(ctx: Context<any, any>, token: string): string {
	if (!ctx.request) {
		return "";
	}
	const { method, url, headers } = ctx.request;
	const userAgent = ctx.request.headers.get("User-Agent") || "";
	const ip = getIp(ctx.request) || "";
	const headerString = JSON.stringify(headers);
	const uniqueString = `${method}:${url}:${headerString}:${userAgent}:${ip}:${token}`;
	return uniqueString;
}

export const getSession = <Option extends BetterAuthOptions>() =>
	createAuthEndpoint(
		"/session",
		{
			method: "GET",
			requireHeaders: true,
		},
		async (ctx) => {
			try {
				const sessionCookieToken = await ctx.getSignedCookie(
					ctx.context.authCookies.sessionToken.name,
					ctx.context.secret,
				);

				if (!sessionCookieToken) {
					return ctx.json(null, {
						status: 401,
					});
				}

				const key = getRequestUniqueKey(ctx, sessionCookieToken);

				const session =
					await ctx.context.internalAdapter.findSession(sessionCookieToken);
				if (!session || session.session.expiresAt < new Date()) {
					deleteSessionCookie(ctx);
					if (session) {
						/**
						 * if session expired clean up the session
						 */
						await ctx.context.internalAdapter.deleteSession(session.session.id);
					}
					return ctx.json(null, {
						status: 401,
					});
				}
				const dontRememberMe = await ctx.getSignedCookie(
					ctx.context.authCookies.dontRememberToken.name,
					ctx.context.secret,
				);
				/**
				 * We don't need to update the session if the user doesn't want to be remembered
				 */
				if (dontRememberMe) {
					return ctx.json(
						session as unknown as {
							session: InferSession<Option>;
							user: InferUser<Option>;
						},
					);
				}
				const expiresIn = ctx.context.sessionConfig.expiresIn;
				const updateAge = ctx.context.sessionConfig.updateAge;
				/**
				 * Calculate last updated date to throttle write updates to database
				 * Formula: ({expiry date} - sessionMaxAge) + sessionUpdateAge
				 *
				 * e.g. ({expiry date} - 30 days) + 1 hour
				 *
				 * inspired by: https://github.com/nextauthjs/next-auth/blob/main/packages/core/src/lib/
				 * actions/session.ts
				 */
				const sessionIsDueToBeUpdatedDate =
					session.session.expiresAt.valueOf() -
					expiresIn * 1000 +
					updateAge * 1000;
				const shouldBeUpdated = sessionIsDueToBeUpdatedDate <= Date.now();

				if (shouldBeUpdated) {
					const updatedSession =
						await ctx.context.internalAdapter.updateSession(
							session.session.id,
							{
								expiresAt: getDate(ctx.context.sessionConfig.expiresIn, "sec"),
							},
						);
					if (!updatedSession) {
						/**
						 * Handle case where session update fails (e.g., concurrent deletion)
						 */
						deleteSessionCookie(ctx);
						return ctx.json(null, { status: 401 });
					}
					const maxAge =
						(updatedSession.expiresAt.valueOf() - Date.now()) / 1000;
					await setSessionCookie(ctx, updatedSession.id, false, {
						maxAge,
					});
					return ctx.json({
						session: updatedSession,
						user: session.user,
					} as unknown as {
						session: InferSession<Option>;
						user: InferUser<Option>;
					});
				}

				return ctx.json(
					session as unknown as {
						session: InferSession<Option>;
						user: InferUser<Option>;
					},
				);
			} catch (error) {
				ctx.context.logger.error(error);
				return ctx.json(null, { status: 500 });
			}
		},
	);

export const getSessionFromCtx = async (ctx: Context<any, any>) => {
	const session = await getSession()({
		...ctx,
		//@ts-expect-error: By default since this request context comes from a router it'll have a `router` flag which force it to be a request object
		_flag: undefined,
	});
	return session;
};

export const sessionMiddleware = createAuthMiddleware(async (ctx) => {
	const session = await getSessionFromCtx(ctx);
	if (!session?.session) {
		throw new APIError("UNAUTHORIZED");
	}
	return {
		session,
	};
});

/**
 * user active sessions list
 */
export const listSessions = <Option extends BetterAuthOptions>() =>
	createAuthEndpoint(
		"/user/list-sessions",
		{
			method: "GET",
			use: [sessionMiddleware],
			requireHeaders: true,
		},
		async (ctx) => {
			const sessions = await ctx.context.adapter.findMany<Session>({
				model: ctx.context.tables.session.tableName,
				where: [
					{
						field: "userId",
						value: ctx.context.session.user.id,
					},
				],
			});
			const activeSessions = sessions.filter((session) => {
				return session.expiresAt > new Date();
			});
			return ctx.json(
				activeSessions as unknown as Prettify<InferSession<Option>>[],
			);
		},
	);

/**
 * revoke a single session
 */
export const revokeSession = createAuthEndpoint(
	"/user/revoke-session",
	{
		method: "POST",
		body: z.object({
			id: z.string(),
		}),
		use: [sessionMiddleware],
		requireHeaders: true,
	},
	async (ctx) => {
		const id = ctx.body.id;
		const findSession = await ctx.context.internalAdapter.findSession(id);
		if (!findSession) {
			return ctx.json(null, { status: 400 });
		}
		if (findSession.session.userId !== ctx.context.session.user.id) {
			return ctx.json(null, { status: 403 });
		}
		try {
			await ctx.context.internalAdapter.deleteSession(id);
		} catch (error) {
			ctx.context.logger.error(error);
			return ctx.json(null, { status: 500 });
		}
		return ctx.json({
			status: true,
		});
	},
);
/**
 * revoke all user sessions
 */
export const revokeSessions = createAuthEndpoint(
	"/user/revoke-sessions",
	{
		method: "POST",
		use: [sessionMiddleware],
		requireHeaders: true,
	},
	async (ctx) => {
		try {
			await ctx.context.internalAdapter.deleteSessions(
				ctx.context.session.user.id,
			);
		} catch (error) {
			ctx.context.logger.error(error);
			return ctx.json(null, { status: 500 });
		}
		return ctx.json({
			status: true,
		});
	},
);
