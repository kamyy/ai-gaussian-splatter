/**
 * The Google Analytics 4 measurement ID, or undefined when this build has none.
 *
 * NEXT_PUBLIC_GA_MEASUREMENT_ID is compiled in at build time, and only the deploy job's production image sets it. Local
 * and CI builds therefore load no analytics and show no privacy banner.
 */

export const GA_MEASUREMENT_ID = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID || undefined;
