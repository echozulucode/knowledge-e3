/**
 * Admin building blocks (the admin UX review §3.2). Each component
 * is also importable from its own file; this barrel is for convenience.
 *
 * Choosing an edit surface (§3.3): ≤ ~5 fields → EditDialog; detail with
 * actions or history → side sheet; many/dependent fields or a live preview →
 * EditPageLayout. Collections → DataTable (+ OverflowMenu for row actions,
 * EmptyState for nothing-here, StatusChip for state, useReorder/ReorderList for order).
 */
export { DataTable, type DataTableColumn, type DataTableProps } from './DataTable.js';
export { OverflowMenu, type OverflowMenuItem, type OverflowMenuProps } from './OverflowMenu.js';
export { EmptyState, type EmptyStateProps } from './EmptyState.js';
export { StatusChip, StatusIcon, type StatusChipProps, type StatusTone } from './StatusChip.js';
export { FormField, formFieldDescribedBy, formFieldErrorId, formFieldHelperId, type FormFieldControlProps, type FormFieldProps } from './FormField.js';
export { FormSection, type FormSectionProps } from './FormSection.js';
export { EditPageLayout, type EditPageLayoutProps } from './EditPageLayout.js';
export { EditDialog, type EditDialogProps } from './EditDialog.js';
export { ReorderList, useReorder, moveItem, type ReorderListProps, type UseReorderOptions, type UseReorderResult } from './ReorderList.js';
export { useUnsavedChangesGuard, UNSAVED_CHANGES_MESSAGE } from './useUnsavedChangesGuard.js';
export { ConfirmDialog, type ConfirmDialogProps } from './ConfirmDialog.js';
export type { SortDirection, SortState } from './DataTable.model.js';
export { Sheet, type SheetForm, type SheetProps, type SheetTab } from './Sheet.js';
export { Freshness, type FreshnessProps } from './Freshness.js';
export { freshnessAgo } from './Freshness.model.js';
