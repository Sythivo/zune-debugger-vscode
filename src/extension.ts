'use strict';

import * as Net from 'net';
import * as vscode from 'vscode';
import { ZuneDebugSession, LaunchRequest } from './zuneDebugger';
import path = require('path');

const DEBUGGER_TYPE = "zune-luau";

export function activate(context: vscode.ExtensionContext) {
	context.subscriptions.push(
		vscode.debug.registerDebugConfigurationProvider(DEBUGGER_TYPE, new ZuneDebugAdapterConfigurationProvider())
	);

	context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider(DEBUGGER_TYPE, {
		provideDebugConfigurations(folder: vscode.WorkspaceFolder | undefined): vscode.ProviderResult<vscode.DebugConfiguration[]> {
			return [
				{
					type: DEBUGGER_TYPE,
					name: "Launch",
					request: "launch",
					program: "${file}"
				}
			];
		}
	}, vscode.DebugConfigurationProviderTriggerKind.Dynamic));

	const debugAdapter = new ZuneDebugAdapterServerDescriptorFactory();
	context.subscriptions.push(
		vscode.debug.registerDebugAdapterDescriptorFactory(DEBUGGER_TYPE, debugAdapter)
	);
	context.subscriptions.push(debugAdapter);
}

export function deactivate() {
	// nothing to do
}

class ZuneDebugAdapterServerDescriptorFactory implements vscode.DebugAdapterDescriptorFactory {
	private server?: Net.Server;

	createDebugAdapterDescriptor(session: vscode.DebugSession, executable: vscode.DebugAdapterExecutable | undefined): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
		if (!this.server) {
			this.server = Net.createServer(socket => {
				const session = new ZuneDebugSession();
				session.setRunAsServer(true);
				session.start(socket as NodeJS.ReadableStream, socket);
			}).listen(0);
		}
		return new vscode.DebugAdapterServer((this.server.address() as Net.AddressInfo).port);
	}

	dispose() {
		if (this.server) {
			this.server.close();
		}
	}
}

function isLuau(id: string): boolean {
	return id === "luau" || id === "lua";
}

class ZuneDebugAdapterConfigurationProvider implements vscode.DebugConfigurationProvider {
	async resolveDebugConfiguration(
		folder: vscode.WorkspaceFolder | undefined,
		config: vscode.DebugConfiguration & Partial<LaunchRequest>,
		token?: vscode.CancellationToken
	): Promise<vscode.DebugConfiguration | null | undefined> {
		const editor = vscode.window.activeTextEditor;
		if (!config.request || !config.type) {
			config.request = "launch";
			config.type = DEBUGGER_TYPE;
			if (!editor || !isLuau(editor.document.languageId) || editor.document.isUntitled) {
				return void vscode.window.showErrorMessage("Nothing to debug");
			}
		}

		if (!config.program) {
			return void vscode.window.showErrorMessage("'program' not set in launch.json");
		}
		if (!config.debuggerPath) {
			config.debuggerPath = "zune";
		}
		if (!config.cwd) {
			config.cwd = config.workspacePath;
		}

		if (folder) {
			config.workspacePath = folder.uri.fsPath;
		} else if (vscode.window.activeTextEditor) {
			config.workspacePath = path.dirname(vscode.window.activeTextEditor.document.uri.fsPath);
		} else {
			return void vscode.window.showErrorMessage("No path found for the workspace");
		}

		return config;
	}
}
