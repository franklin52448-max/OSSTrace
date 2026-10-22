// Tabler icons (MIT, Copyright (c) 2020-2024 Paweł Kuna), as shipped by Helium Prism.
import type { ReactNode, SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function icon(paths: ReactNode) {
  return function Icon(props: IconProps) {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        {...props}
      >
        {paths}
      </svg>
    );
  };
}

export const IconArrowBackUp = icon(<><path d="M9 13l-4 -4l4 -4" /><path d="M5 9h7a4 4 0 1 1 0 8h-1" /></>);
export const IconArrowDown = icon(<><path d="M12 5l0 14" /><path d="M18 13l-6 6" /><path d="M6 13l6 6" /></>);
export const IconArrowLeft = icon(<><path d="M5 12l14 0" /><path d="M5 12l6 6" /><path d="M5 12l6 -6" /></>);
export const IconArrowRight = icon(<><path d="M5 12l14 0" /><path d="M13 18l6 -6" /><path d="M13 6l6 6" /></>);
export const IconArrowUp = icon(<><path d="M12 5l0 14" /><path d="M18 11l-6 -6" /><path d="M6 11l6 -6" /></>);
export const IconBang = icon(
  <><path d="M3 10a7 7 0 1 0 14 0a7 7 0 1 0 -14 0" /><path d="M21 21l-6 -6" /><path d="M10 13v.01" /><path d="M10 7v3" /></>,
);
export const IconCheck = icon(<path d="M5 12l5 5l10 -10" />);
export const IconChevronDown = icon(<path d="M6 9l6 6l6 -6" />);
export const IconCopy = icon(
  <>
    <path d="M7 9.667a2.667 2.667 0 0 1 2.667 -2.667h8.666a2.667 2.667 0 0 1 2.667 2.667v8.666a2.667 2.667 0 0 1 -2.667 2.667h-8.666a2.667 2.667 0 0 1 -2.667 -2.667l0 -8.666" />
    <path d="M4.012 16.737a2.005 2.005 0 0 1 -1.012 -1.737v-10c0 -1.1 .9 -2 2 -2h10c.75 0 1.158 .385 1.5 1" />
  </>,
);
export const IconDownload = icon(
  <><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2" /><path d="M7 11l5 5l5 -5" /><path d="M12 4l0 12" /></>,
);
export const IconExternalLink = icon(
  <><path d="M12 6h-6a2 2 0 0 0 -2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-6" /><path d="M11 13l9 -9" /><path d="M15 4h5v5" /></>,
);
export const IconEye = icon(
  <><path d="M10 12a2 2 0 1 0 4 0a2 2 0 0 0 -4 0" /><path d="M21 12c-2.4 4 -5.4 6 -9 6c-3.6 0 -6.6 -2 -9 -6c2.4 -4 5.4 -6 9 -6c3.6 0 6.6 2 9 6" /></>,
);
export const IconEyeOff = icon(
  <><path d="M10.585 10.587a2 2 0 0 0 2.829 2.828" /><path d="M16.681 16.673a8.717 8.717 0 0 1 -4.681 1.327c-3.6 0 -6.6 -2 -9 -6c1.272 -2.12 2.712 -3.678 4.32 -4.674m2.86 -1.146a9.055 9.055 0 0 1 1.82 -.18c3.6 0 6.6 2 9 6c-.666 1.11 -1.379 2.067 -2.138 2.87" /><path d="M3 3l18 18" /></>,
);
export const IconInfo = icon(<><path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0" /><path d="M12 9h.01" /><path d="M11 12h1v4h1" /></>);
export const IconLink = icon(
  <>
    <path d="M9 15l6 -6" />
    <path d="M11 6l.463 -.536a5 5 0 0 1 7.071 7.072l-.534 .464" />
    <path d="M13 18l-.397 .534a5.068 5.068 0 0 1 -7.127 0a4.972 4.972 0 0 1 0 -7.071l.524 -.463" />
  </>,
);
export const IconLoader = icon(<path d="M12 3a9 9 0 1 0 9 9" />);
export const IconMoon = icon(
  <path d="M12 3c.132 0 .263 0 .393 0a7.5 7.5 0 0 0 7.92 12.446a9 9 0 1 1 -8.313 -12.454z" />,
);
export const IconPalette = icon(
  <>
    <path d="M12 21a9 9 0 0 1 0 -18c4.97 0 9 3.582 9 8c0 1.06 -.474 2.078 -1.318 2.828c-.844 .75 -1.989 1.172 -3.182 1.172h-2.5a2 2 0 0 0 -1 3.75a1.3 1.3 0 0 1 -1 2.25" />
    <path d="M8.5 10.5m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" />
    <path d="M12.5 7.5m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" />
    <path d="M16.5 10.5m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" />
  </>,
);
export const IconSearch = icon(<><path d="M3 10a7 7 0 1 0 14 0a7 7 0 1 0 -14 0" /><path d="M21 21l-6 -6" /></>);
export const IconSun = icon(
  <>
    <path d="M12 12m-4 0a4 4 0 1 0 8 0a4 4 0 1 0 -8 0" />
    <path d="M12 3l0 1" />
    <path d="M12 20l0 1" />
    <path d="M3 12l1 0" />
    <path d="M20 12l1 0" />
    <path d="M5.6 5.6l.7 .7" />
    <path d="M17.7 17.7l.7 .7" />
    <path d="M5.6 18.4l.7 -.7" />
    <path d="M17.7 6.3l.7 -.7" />
  </>,
);
export const IconWorld = icon(
  <>
    <path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0" />
    <path d="M3.6 9h16.8" />
    <path d="M3.6 15h16.8" />
    <path d="M11.5 3a17 17 0 0 0 0 18" />
    <path d="M12.5 3a17 17 0 0 1 0 18" />
  </>,
);
export const IconX = icon(<><path d="M18 6l-12 12" /><path d="M6 6l12 12" /></>);
