import { createGlobalStyle } from "styled-components";

const GlobalStyles = createGlobalStyle`
:root {


  /* Grey */
  &, &.light-mode{
    --color-grey-0: #fff;
    --color-grey-50: #f9fafb;
    --color-grey-100: #f3f4f6;
    --color-grey-200: #e5e7eb;
    --color-grey-300: #d1d5db;
    --color-grey-400: #9ca3af;
    --color-grey-500: #6b7280;
    --color-grey-600: #4b5563;
    --color-grey-700: #374151;
    --color-grey-800: #1f2937;
    --color-grey-900: #111827;

    --color-blue-100: #e0f2fe;
    --color-blue-700: #0369a1;
    --color-green-100: #dcfce7;
    --color-green-700: #15803d;
    --color-yellow-100: #fef9c3;
    --color-yellow-700: #a16207;
    --color-silver-100: #e5e7eb;
    --color-silver-700: #374151;
    --color-indigo-100: #e0e7ff;
    --color-indigo-700: #4338ca;

    --color-red-100: #fee2e2;
    --color-red-700: #b91c1c;
    --color-red-800: #991b1b;

    --backdrop-color: rgba(255, 255, 255, 0.1);

    --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.04);
    --shadow-md: 0px 0.6rem 2.4rem rgba(0, 0, 0, 0.06);
    --shadow-lg: 0 2.4rem 3.2rem rgba(0, 0, 0, 0.12);

    --image-grayscale: 0;
    --image-opacity: 100%;

    /* s2: surfaces */
    --s2-bg: #f4f4f8;
    --s2-bg-sunken: #ececf3;
    --s2-surface-subtle: #f7f7fb;
    --s2-surface: #ffffff;
    --s2-surface-raised: #f0f0f6;

    /* s2: text */
    --s2-border: #d4d4e0;
    --s2-border-strong: #8b8ba3;
    --s2-text-strong: #12121f;
    --s2-on-accent: #ffffff;
    --s2-text: #1a1a2e;
    --s2-text-secondary: #33334a;
    --s2-text-muted: #4a4a5e;
    --s2-text-dim: #6b6b80;

    /* s2: controls */
    --s2-btn-neutral: #e2e2ea;
    --s2-disabled-bg: #ececf3;
    --s2-swatch-border: #8b8ba3;

    /* s2: accents */
    --s2-accent: #2563eb;
    --s2-selected: #946005;
    --s2-danger: #b91c1c;
    --s2-danger-soft: #c81e1e;
    --s2-success: #15803d;
    --s2-success-alt: #047857;
    --s2-warning: #b45309;
    --s2-warning-soft: #946005;
    --s2-warning-bright: #854d0e;
    --s2-warning-mid: #854d0e;

    /* s2: extended solids */
    --s2-row: #eaeaf2;
    --s2-btn-primary: #1d4ed8;
    --s2-btn-info: #1d4ed8;
    --s2-btn-grey: #d0d0dc;
    --s2-btn-purple: #6d28d9;
    --s2-variant-gpu: #15803d;
    --s2-tab-entity: #946005;
    --s2-tab-items: #be185d;
    --s2-tab-maps: #047857;

    /* s2: translucent */
    --s2-overlay-subtle: rgba(0,0,0,0.02);
    --s2-overlay: rgba(0,0,0,0.035);
    --s2-hairline: rgba(0,0,0,0.08);
    --s2-hairline-strong: rgba(0,0,0,0.18);
    --s2-text-ghost: rgba(0,0,0,0.45);
    --s2-scrim: rgba(0,0,0,0.45);
    --s2-scrim-soft: rgba(0,0,0,0.28);
    --s2-shadow: rgba(0,0,0,0.14);
    --s2-panel-veil: rgba(255,255,255,0.9);
    --s2-panel-veil-solid: rgba(255,255,255,0.96);
    --s2-accent-tint: rgba(37,99,235,0.08);
    --s2-accent-tint-strong: rgba(37,99,235,0.22);
    --s2-selected-tint: rgba(148,96,5,0.10);
    --s2-selected-tint-strong: rgba(148,96,5,0.28);
  }
  &.dark-mode{

    --color-grey-0: #18212f;
    --color-grey-50: #111827;
    --color-grey-100: #1f2937;
    --color-grey-200: #374151;
    --color-grey-300: #4b5563;
    --color-grey-400: #6b7280;
    --color-grey-500: #9ca3af;
    --color-grey-600: #d1d5db;
    --color-grey-700: #e5e7eb;
    --color-grey-800: #f3f4f6;
    --color-grey-900: #f9fafb;

    --color-blue-100: #075985;
    --color-blue-700: #e0f2fe;
    --color-green-100: #166534;
    --color-green-700: #dcfce7;
    --color-yellow-100: #854d0e;
    --color-yellow-700: #fef9c3;
    --color-silver-100: #374151;
    --color-silver-700: #f3f4f6;
    --color-indigo-100: #3730a3;
    --color-indigo-700: #e0e7ff;

    --color-red-100: #fee2e2;
    --color-red-700: #b91c1c;
    --color-red-800: #991b1b;

    --backdrop-color: rgba(0, 0, 0, 0.3);

    --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.4);
    --shadow-md: 0px 0.6rem 2.4rem rgba(0, 0, 0, 0.3);
    --shadow-lg: 0 2.4rem 3.2rem rgba(0, 0, 0, 0.4);

    --image-grayscale: 10%;
    --image-opacity: 90%;

    /* s2: surfaces */
    --s2-bg: #0f0f1a;
    --s2-bg-sunken: #12121f;
    --s2-surface-subtle: #161625;
    --s2-surface: #1a1a2e;
    --s2-surface-raised: #23233f;

    /* s2: text */
    --s2-border: #2e2e3e;
    --s2-border-strong: #3a3a4e;
    --s2-text-strong: #fff;
    --s2-on-accent: #fff;
    --s2-text: #eee;
    --s2-text-secondary: #ccc;
    --s2-text-muted: #aaa;
    --s2-text-dim: #888;

    /* s2: controls */
    --s2-btn-neutral: #555;
    --s2-disabled-bg: #555;
    --s2-swatch-border: #555;

    /* s2: accents */
    --s2-accent: #4a9eff;
    --s2-selected: #facc15;
    --s2-danger: #ef4444;
    --s2-danger-soft: #f87171;
    --s2-success: #22c55e;
    --s2-success-alt: #10b981;
    --s2-warning: #f59e0b;
    --s2-warning-soft: #fcd34d;
    --s2-warning-bright: #fde047;
    --s2-warning-mid: #eab308;

    /* s2: extended solids */
    --s2-row: #1f1f35;
    --s2-btn-primary: #3a7ed8;
    --s2-btn-info: #3b82f6;
    --s2-btn-grey: #4b5563;
    --s2-btn-purple: #8b5cf6;
    --s2-variant-gpu: #4ade80;
    --s2-tab-entity: #facc15;
    --s2-tab-items: #f472b6;
    --s2-tab-maps: #34d399;

    /* s2: translucent */
    --s2-overlay-subtle: rgba(255,255,255,0.03);
    --s2-overlay: rgba(255,255,255,0.05);
    --s2-hairline: rgba(255,255,255,0.1);
    --s2-hairline-strong: rgba(255,255,255,0.3);
    --s2-text-ghost: rgba(255,255,255,0.4);
    --s2-scrim: rgba(0,0,0,0.8);
    --s2-scrim-soft: rgba(0,0,0,0.5);
    --s2-shadow: rgba(0,0,0,0.4);
    --s2-panel-veil: rgba(26,26,46,0.85);
    --s2-panel-veil-solid: rgba(46,46,74,0.95);
    --s2-accent-tint: rgba(74,158,255,0.1);
    --s2-accent-tint-strong: rgba(74,158,255,0.3);
    --s2-selected-tint: rgba(250,204,21,0.1);
    --s2-selected-tint-strong: rgba(250,204,21,0.3);
  }


    /* Indigo */
  --color-brand-50: #eef2ff;
  --color-brand-100: #e0e7ff;
  --color-brand-200: #c7d2fe;
  --color-brand-500: #6366f1;
  --color-brand-600: #4f46e5;
  --color-brand-700: #4338ca;
  --color-brand-800: #3730a3;
  --color-brand-900: #312e81;

  --border-radius-tiny: 3px;
  --border-radius-sm: 5px;
  --border-radius-md: 7px;
  --border-radius-lg: 9px;

}

*,
*::before,
*::after {
  box-sizing: border-box;
  padding: 0;
  margin: 0;

  /* Creating animations for dark mode */
  transition: background-color 0.3s, border 0.3s;
}

html {
  font-size: 62.5%;
}

body {
  font-family: "Poppins", sans-serif;
  color: var(--color-grey-700);

  transition: color 0.3s, background-color 0.3s;
  min-height: 100vh;
  line-height: 1.5;
  font-size: 1.6rem;
}

input,
button,
textarea,
select {
  font: inherit;
  color: inherit;
}

button {
  cursor: pointer;
}

*:disabled {
  cursor: not-allowed;
}

select:disabled,
input:disabled {
  background-color: var(--color-grey-200);
  color: var(--color-grey-500);
}

input:focus,
button:focus,
textarea:focus,
select:focus {
  outline: 2px solid var(--color-brand-600);
  outline-offset: -1px;
}

/* Parent selector, finally 😃 */
button:has(svg) {
  line-height: 0;
}

a {
  color: inherit;
  text-decoration: none;
}

ul {
  list-style: none;
}

p,
h1,
h2,
h3,
h4,
h5,
h6 {
  overflow-wrap: break-word;
  hyphens: auto;
}

img {
  max-width: 100%;

  /* For dark mode */
  filter: grayscale(var(--image-grayscale)) opacity(var(--image-opacity));
}

/*
FOR DARK MODE

--color-grey-0: #18212f;
--color-grey-50: #111827;
--color-grey-100: #1f2937;
--color-grey-200: #374151;
--color-grey-300: #4b5563;
--color-grey-400: #6b7280;
--color-grey-500: #9ca3af;
--color-grey-600: #d1d5db;
--color-grey-700: #e5e7eb;
--color-grey-800: #f3f4f6;
--color-grey-900: #f9fafb;

--color-blue-100: #075985;
--color-blue-700: #e0f2fe;
--color-green-100: #166534;
--color-green-700: #dcfce7;
--color-yellow-100: #854d0e;
--color-yellow-700: #fef9c3;
--color-silver-100: #374151;
--color-silver-700: #f3f4f6;
--color-indigo-100: #3730a3;
--color-indigo-700: #e0e7ff;

--color-red-100: #fee2e2;
--color-red-700: #b91c1c;
--color-red-800: #991b1b;

--backdrop-color: rgba(0, 0, 0, 0.3);

--shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.4);
--shadow-md: 0px 0.6rem 2.4rem rgba(0, 0, 0, 0.3);
--shadow-lg: 0 2.4rem 3.2rem rgba(0, 0, 0, 0.4);

--image-grayscale: 10%;
--image-opacity: 90%;
*/
`;

export default GlobalStyles;