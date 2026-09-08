import {
  Blocks,
  Box,
  CalendarClock,
  CircleArrowUp,
  FolderKanban,
  KeyRound,
  LayoutDashboard,
  Bell,
  ScrollText,
  Settings,
  Users,
  type LucideIcon,
} from 'lucide-react';

/**
 * nav — 侧栏导航单一数据源（分组/路由/标题/占位批次）。
 * router.tsx 的路由注册与 Topbar 的标题、PlaceholderPage 的批次标注都从这里取值。
 */
export interface NavItem {
  /** react-router 路径（也是 hash 路由的 location.pathname） */
  path: string;
  label: string;
  icon: LucideIcon;
  /** 页面标题（Topbar 与 document.title 用） */
  title: string;
  /** 占位说明（PlaceholderPage 副标题） */
  description: string;
  /** 计划填充的批次标注 */
  batch: string;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    label: '概览',
    items: [
      {
        path: '/',
        label: '仪表盘',
        icon: LayoutDashboard,
        title: '仪表盘',
        description: '系统运行状态、资源用量与关键指标的总览视图。',
        batch: 'W2',
      },
    ],
  },
  {
    label: '管理',
    items: [
      {
        path: '/extensions',
        label: '扩展',
        icon: Blocks,
        title: '扩展',
        description: '扩展的启停、重载、贡献点与路由查看管理。',
        batch: 'W2',
      },
      {
        path: '/cron',
        label: '定时任务',
        icon: CalendarClock,
        title: '定时任务',
        description: '定时任务的创建、启停、手动触发与运行历史。',
        batch: 'W3',
      },
      {
        path: '/notifications',
        label: '通知中心',
        icon: Bell,
        title: '通知中心',
        description: '站内通知收件箱、已读管理与投递渠道配置。',
        batch: 'W3',
      },
      {
        path: '/files-tasks',
        label: '文件与任务',
        icon: FolderKanban,
        title: '文件与任务',
        description: '扩展文件库与后台异步任务（进度/取消/结果）管理。',
        batch: 'W3',
      },
      {
        path: '/sandbox',
        label: '沙箱',
        icon: Box,
        title: '沙箱',
        description: '容器工作区列表、执行命令与文件浏览。',
        batch: 'W4',
      },
      {
        path: '/users',
        label: '用户',
        icon: Users,
        title: '用户',
        description: '用户账号、角色与密码管理。',
        batch: 'W4',
      },
      {
        path: '/api-keys',
        label: 'API Keys',
        icon: KeyRound,
        title: 'API Keys',
        description: 'API Key 的签发、查看与吊销。',
        batch: 'W4',
      },
      {
        path: '/logs',
        label: '日志',
        icon: ScrollText,
        title: '日志',
        description: '内核与扩展日志的实时流与检索。',
        batch: 'W4',
      },
    ],
  },
  {
    label: '系统',
    items: [
      {
        path: '/settings',
        label: '设置',
        icon: Settings,
        title: '设置',
        description: '系统偏好设置，将包含「外观」主题定制器（模式/强调色/圆角/密度/自定义变量覆盖）。',
        batch: 'W4',
      },
      {
        path: '/update',
        label: '升级',
        icon: CircleArrowUp,
        title: '升级',
        description: '版本检查、升级执行与历史记录。',
        batch: 'W4',
      },
    ],
  },
];

export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

/** 按当前路径解析导航项（精确匹配；未匹配返回 undefined） */
export function findNavItem(pathname: string): NavItem | undefined {
  return NAV_ITEMS.find((item) => item.path === pathname);
}
