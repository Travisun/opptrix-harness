import { PlaceholderPage } from '@/components/PlaceholderPage';
import { findNavItem } from '@/lib/nav';

export default function McpPage() {
  const item = findNavItem('/mcp');
  if (!item) return null;
  return <PlaceholderPage item={item} />;
}
