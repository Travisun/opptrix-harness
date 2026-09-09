import { PlaceholderPage } from '@/components/PlaceholderPage';
import { findNavItem, type NavItem } from '@/lib/nav';

/**
 * 占位页快捷组件：按路径查 NAV 元数据渲染统一空态（W2/W3/W4 按批次替换整文件实现）。
 */
export function PlaceholderFor({ path }: { path: string }): React.ReactNode {
  const item: NavItem | undefined = findNavItem(path);
  if (item === undefined) return null;
  return <PlaceholderPage item={item} />;
}
