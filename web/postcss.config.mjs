/**
 * PostCSS configuration, which runs Tailwind CSS over the stylesheets.
 *
 * Next.js reads this file when it builds CSS. Tailwind's own settings live in web/app/globals.css.
 */

export default {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};
