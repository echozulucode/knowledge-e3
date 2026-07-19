import { useMemo } from 'react';
import {
  MarkdownEditor,
  type ChangeMeta,
  type EditorDiagnostic,
  type EditorMode,
  type FrontmatterPropertySchema,
  type HostServices,
  type ModeChangeMeta,
} from '@echozedlabs/react';
import '@echozedlabs/react/styles.css';
import {
  getDefaultItemEditorModes,
  knowledgeItemPropertySchema,
} from './ItemEditorHostConfig.js';
import { itemEditorModeIcons, itemEditorToolbarIcons } from '../../icons.js';
export {
  buildKnowledgeItemPropertySchema,
  createItemEditorHostServices,
  getDefaultItemEditorModes,
  itemToLinkSuggestion,
  knowledgeItemPropertySchema,
  searchItemLinkSuggestions,
  uploadImageAsset,
  type CreateItemHostServicesOptions,
  type ItemLinkSearchResult,
} from './ItemEditorHostConfig.js';

/**
 * Thin Knowledge E3 host boundary around the reusable markdown-editor package.
 *
 * Rules for this component:
 * - Keep editor internals in ../markdown-editor packages.
 * - Keep Knowledge E3 concerns here: item metadata schema, persistence callbacks,
 *   diagnostics routing, save/cancel shortcuts, and item-link host services.
 * - If Knowledge E3 needs new editor behavior, add it to markdown-editor first and
 *   consume the public API here.
 */
export interface ItemEditorHostProps {
  value: string;
  mode?: EditorMode;
  modes?: EditorMode[];
  readOnly?: boolean;
  className?: string;
  ariaLabel?: string;
  propertySchema?: FrontmatterPropertySchema[];
  frontmatterDisplay?: 'expanded' | 'collapsed' | 'hidden';
  hostServices?: HostServices;
  onChange(markdown: string, meta: ChangeMeta): void;
  onModeChange?: (mode: EditorMode, meta: ModeChangeMeta) => void;
  onSaveShortcut?: () => void;
  onCancelShortcut?: () => void;
  onDiagnostics?: (diagnostics: EditorDiagnostic[]) => void;
}

export function ItemEditorHost({
  value,
  mode,
  modes,
  readOnly = false,
  className,
  ariaLabel = 'Knowledge item Markdown editor',
  propertySchema,
  frontmatterDisplay = 'collapsed',
  hostServices,
  onChange,
  onModeChange,
  onSaveShortcut,
  onCancelShortcut,
  onDiagnostics,
}: ItemEditorHostProps) {
  const effectiveModes = useMemo<EditorMode[]>(() => {
    if (modes && modes.length > 0) return modes;
    return getDefaultItemEditorModes(readOnly);
  }, [modes, readOnly]);

  return (
    <MarkdownEditor
      value={value}
      mode={mode}
      modes={effectiveModes}
      readOnly={readOnly}
      className={className}
      ariaLabel={ariaLabel}
      propertySchema={propertySchema ?? knowledgeItemPropertySchema}
      frontmatterDisplay={frontmatterDisplay}
      hostServices={hostServices}
      // Host-service toolbar (page-link search + image upload) while editing; the
      // upload button calls hostServices.uploadAsset (uploadImageAsset). Off in read-only.
      hostServiceToolbar={!readOnly}
      modeIcons={itemEditorModeIcons}
      wysiwygToolbarIcons={itemEditorToolbarIcons}
      features={{
        toolbar: !readOnly,
        modeSwitcher: !readOnly && effectiveModes.length > 1,
        wikiLinks: true,
        syntaxHighlighting: true,
        tables: true,
        images: true,
        callouts: true,
        diagrams: true,
        mermaid: true,
        plantUml: true,
      }}
      onChange={onChange}
      onModeChange={onModeChange}
      onSaveShortcut={onSaveShortcut}
      onCancelShortcut={onCancelShortcut}
      onDiagnostics={onDiagnostics}
    />
  );
}
