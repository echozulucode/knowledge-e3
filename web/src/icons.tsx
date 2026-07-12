import type { ReactNode } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core';
import {
  faAnglesLeft,
  faAnglesRight,
  faArrowRight,
  faBars,
  faBold,
  faBook,
  faBookOpen,
  faBoltLightning,
  faCheckSquare,
  faChevronRight,
  faCircleNodes,
  faCircleQuestion,
  faClock,
  faClockRotateLeft,
  faCode,
  faCompass,
  faCopy,
  faDesktop,
  faDiagramProject,
  faEye,
  faFileLines,
  faFloppyDisk,
  faGaugeHigh,
  faGear,
  faHighlighter,
  faHouse,
  faImage,
  faItalic,
  faKey,
  faLayerGroup,
  faList,
  faListCheck,
  faListOl,
  faListUl,
  faMagnifyingGlass,
  faMoon,
  faObjectGroup,
  faPenNib,
  faPencil,
  faPlus,
  faRightFromBracket,
  faScaleBalanced,
  faShieldHalved,
  faSliders,
  faStar,
  faSun,
  faTag,
  faTriangleExclamation,
  faUser,
  faUsers,
  faWandMagicSparkles,
  faWrench,
  faXmark,
} from '@fortawesome/free-solid-svg-icons';
import type { EditorMode } from '@echozedlabs/react';
import type { WysiwygToolbarIcons } from '@echozedlabs/wysiwyg-lexical';

export function Icon({ icon, fixedWidth = true }: { icon: IconDefinition; fixedWidth?: boolean }) {
  return <FontAwesomeIcon icon={icon} fixedWidth={fixedWidth} />;
}

export const appIcons = {
  anglesLeft: faAnglesLeft,
  anglesRight: faAnglesRight,
  arrowRight: faArrowRight,
  bars: faBars,
  boltLightning: faBoltLightning,
  book: faBook,
  bookOpen: faBookOpen,
  chevronRight: faChevronRight,
  circleNodes: faCircleNodes,
  circleQuestion: faCircleQuestion,
  clock: faClock,
  clockRotateLeft: faClockRotateLeft,
  compass: faCompass,
  copy: faCopy,
  desktop: faDesktop,
  diagramProject: faDiagramProject,
  eye: faEye,
  fileLines: faFileLines,
  floppyDisk: faFloppyDisk,
  gaugeHigh: faGaugeHigh,
  gear: faGear,
  house: faHouse,
  image: faImage,
  key: faKey,
  layerGroup: faLayerGroup,
  list: faList,
  listCheck: faListCheck,
  magnifyingGlass: faMagnifyingGlass,
  moon: faMoon,
  penNib: faPenNib,
  pencil: faPencil,
  plus: faPlus,
  rightFromBracket: faRightFromBracket,
  scaleBalanced: faScaleBalanced,
  shieldHalved: faShieldHalved,
  sliders: faSliders,
  star: faStar,
  sun: faSun,
  tag: faTag,
  triangleExclamation: faTriangleExclamation,
  user: faUser,
  users: faUsers,
  wandMagicSparkles: faWandMagicSparkles,
  wrench: faWrench,
  xmark: faXmark,
};

/**
 * Resolve a content-type registry `icon` key (from GET /content-types) to a
 * concrete icon. Unknown keys fall back to a neutral file glyph.
 */
const contentTypeIcons: Record<string, IconDefinition> = {
  book: faBook,
  wrench: faWrench,
  circleQuestion: faCircleQuestion,
  listCheck: faListCheck,
  scaleBalanced: faScaleBalanced,
  diagramProject: faDiagramProject,
  penNib: faPenNib,
  layerGroup: faLayerGroup,
  triangleExclamation: faTriangleExclamation,
  tag: faTag,
};

export function iconByKey(key: string | undefined): IconDefinition {
  return (key && contentTypeIcons[key]) || faFileLines;
}

export const itemEditorModeIcons: Partial<Record<EditorMode, ReactNode>> = {
  hybrid: <Icon icon={faLayerGroup} />,
  wysiwyg: <Icon icon={faPenNib} />,
  markdown: <Icon icon={faCode} />,
  preview: <Icon icon={faEye} />,
};

export const itemEditorToolbarIcons: WysiwygToolbarIcons = {
  bold: <Icon icon={faBold} />,
  italic: <Icon icon={faItalic} />,
  inlineCode: <Icon icon={faCode} />,
  bulletedList: <Icon icon={faListUl} />,
  numberedList: <Icon icon={faListOl} />,
  checkboxList: <Icon icon={faCheckSquare} />,
};
