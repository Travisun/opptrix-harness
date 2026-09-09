import { PlaceholderPage } from '@/components/PlaceholderPage';
import { findNavItem } from '@/lib/nav';

export default function PluginsPage() {
  const item = findNavItem('/plugins');
  if (!item) return null;
  return <PlaceholderPage item={item} />;
}
