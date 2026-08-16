/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-foreign-transcript`.
 * @module @deepseek-ai/dsh-foreign-transcript/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-foreign-transcript'

/** Cordis companion plugin name. */
export const name = 'foreign-transcript-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: an imported transcript is inert recall context whose
 * durable source fields are guaranteed by the typed message boundary, so the
 * session holds no cross-event relation this package owns to check; parsing,
 * retention, and expansion behavior are owned by pipeline tests.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
