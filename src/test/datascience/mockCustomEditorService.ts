// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
import { Disposable, EventEmitter, Uri, WebviewPanel, WebviewPanelOptions } from 'vscode';
import {
    CustomDocument,
    CustomEditorEditingCapability,
    CustomEditorProvider,
    ICommandManager,
    ICustomEditorService
} from '../../client/common/application/types';
import { IDisposableRegistry } from '../../client/common/types';
import { noop } from '../../client/common/utils/misc';
import { NotebookModelChange } from '../../client/datascience/interactive-common/interactiveWindowTypes';
import { NativeEditorProvider } from '../../client/datascience/interactive-ipynb/nativeEditorProvider';
import { INotebookEditor, INotebookEditorProvider } from '../../client/datascience/types';
import { createTemporaryFile } from '../utils/fs';

export class MockCustomEditorService implements ICustomEditorService {
    private provider: CustomEditorProvider | undefined;
    private resolvedList = new Map<string, Thenable<void>>();
    private undoStack = new Map<string, unknown[]>();
    private redoStack = new Map<string, unknown[]>();

    constructor(disposableRegistry: IDisposableRegistry, commandManager: ICommandManager) {
        disposableRegistry.push(
            commandManager.registerCommand('workbench.action.files.save', this.onFileSave.bind(this))
        );
        disposableRegistry.push(
            commandManager.registerCommand('workbench.action.files.saveAs', this.onFileSaveAs.bind(this))
        );
    }

    public registerCustomEditorProvider(
        _viewType: string,
        provider: CustomEditorProvider,
        _options?: WebviewPanelOptions | undefined
    ): Disposable {
        // Only support one view type, so just save the provider
        this.provider = provider;

        // Sign up for close so we can clear our resolved map
        // tslint:disable-next-line: no-any
        ((this.provider as any) as INotebookEditorProvider).onDidCloseNotebookEditor(this.closedEditor.bind(this));
        // tslint:disable-next-line: no-any
        ((this.provider as any) as INotebookEditorProvider).onDidOpenNotebookEditor(this.openedEditor.bind(this));

        return { dispose: noop };
    }
    public async openEditor(file: Uri): Promise<void> {
        if (!this.provider) {
            throw new Error('Opening before registering');
        }

        // Make sure not to resolve more than once for the same file. At least in testing.
        let resolved = this.resolvedList.get(file.toString());
        if (!resolved) {
            // Pass undefined as the webview panel. This will make the editor create a new one
            // tslint:disable-next-line: no-any
            resolved = this.provider.resolveCustomEditor(this.createDocument(file), (undefined as any) as WebviewPanel);
            this.resolvedList.set(file.toString(), resolved);
        }

        await resolved;
    }

    public undo(file: Uri) {
        this.popAndApply(file, this.undoStack, this.redoStack, e => {
            this.getModel(file)
                .then(m => {
                    if (m) {
                        m.undoEdits([e as NotebookModelChange]);
                    }
                })
                .ignoreErrors();
        });
    }

    public redo(file: Uri) {
        this.popAndApply(file, this.redoStack, this.undoStack, e => {
            this.getModel(file)
                .then(m => {
                    if (m) {
                        m.applyEdits([e as NotebookModelChange]);
                    }
                })
                .ignoreErrors();
        });
    }

    private popAndApply(
        file: Uri,
        from: Map<string, unknown[]>,
        to: Map<string, unknown[]>,
        apply: (element: unknown) => void
    ) {
        const key = file.toString();
        const fromStack = from.get(key);
        if (fromStack) {
            const element = fromStack.pop();
            apply(element);
            let toStack = to.get(key);
            if (toStack === undefined) {
                toStack = [];
                to.set(key, toStack);
            }
            toStack.push(element);
        }
    }

    private createDocument(file: Uri): CustomDocument {
        const eventEmitter = new EventEmitter<void>();
        return {
            uri: file,
            viewType: NativeEditorProvider.customEditorViewType,
            onDidDispose: eventEmitter.event
        };
    }

    private async getModel(file: Uri): Promise<CustomEditorEditingCapability | undefined> {
        const nativeProvider = this.provider as CustomEditorProvider;
        if (nativeProvider) {
            const model = await nativeProvider.resolveCustomDocument(this.createDocument(file));
            if (model.editing) {
                return model.editing;
            }
        }
        return undefined;
    }

    private async onFileSave(file: Uri) {
        const model = await this.getModel(file);
        if (model) {
            model.save();
        }
    }

    private async onFileSaveAs(file: Uri) {
        const model = await this.getModel(file);
        if (model) {
            const tmp = await createTemporaryFile('.ipynb');
            model.saveAs(Uri.file(tmp.filePath));
        }
    }

    private closedEditor(editor: INotebookEditor) {
        this.resolvedList.delete(editor.file.toString());
    }

    private openedEditor(editor: INotebookEditor) {
        // Listen for model changes
        this.getModel(editor.file)
            .then(m => {
                if (m) {
                    m.onDidEdit(this.onEditChange.bind(this, editor.file));
                }
            })
            .ignoreErrors();
    }

    private onEditChange(file: Uri, e: unknown) {
        let stack = this.undoStack.get(file.toString());
        if (stack === undefined) {
            stack = [];
            this.undoStack.set(file.toString(), stack);
        }
        stack.push(e);
    }
}
