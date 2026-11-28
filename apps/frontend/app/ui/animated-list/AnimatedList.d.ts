import type { CSSProperties, ReactElement, ReactNode } from "react";

export default function AnimatedList<T>(props: {
  items: T[];
  initialSelectedIndex?: number;
  selectedIndex?: number;
  renderItem?: (item: T, index: number, selected: boolean) => ReactNode;
  onItemSelect?: (item: T, index: number) => void;
  selectOnHover?: boolean;
  enableArrowNavigation?: boolean;
  loop?: boolean;
  animation?: "pop" | "slide" | "fade" | "none";
  animateOnce?: boolean;
  stagger?: number;
  showGradients?: boolean;
  fadeSize?: number;
  displayScrollbar?: boolean;
  frame?: boolean;
  theme?: "dark" | "light";
  accentColor?: string;
  radius?: number;
  gap?: number;
  width?: number | string;
  maxHeight?: number | string;
  className?: string;
  itemClassName?: string;
  style?: CSSProperties;
}): ReactElement;
