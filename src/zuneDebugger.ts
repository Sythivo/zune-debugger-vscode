import {
	LoggingDebugSession,
	InitializedEvent, TerminatedEvent, OutputEvent,
	Thread, StackFrame, Scope, Source, Handles, Breakpoint,
	StoppedEvent
} from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import { basename } from 'path-browserify';
import { Subject } from 'await-notify';
import { EventEmitter } from 'events';
import * as childProcess from "child_process";
import * as assert from 'assert';

export interface LaunchRequest {
	program: string;
	args?: string[];
	cwd: string;
	stopOnEntry?: boolean;
	debuggerArgs?: string[];
	debuggerPath: string;
	workspacePath: string;
}

type ILaunchRequestArguments = LaunchRequest & DebugProtocol.LaunchRequestArguments;

interface IAttachRequestArguments extends ILaunchRequestArguments { }

interface LuauVariable {
	id: number;
	value: string;
	type: string;
	parent: number;
}

const enum OutputKind {
	stdout,
	stderr,
}

const enum DebuggerStatus {
	starting,
	command,
	running,
	stopped,
}

type DebuggerStackFrame = { name?: string, src: string, line: number, context: number };
type DebuggerExceptionInfo = { reason?: string, type?: string, kind: number };
type DebuggerVariableInfo = { id: number, key: string, value: string, key_type: "literal" | string, value_type: string };

const INPUT_TAG = "\x1b[0m(dbg) ";
const OUTPUT_TAG = "\x1b[0m(dbg): ";
const LARGEST_TAG_SIZE = Math.max(INPUT_TAG.length, OUTPUT_TAG.length);

export class ZuneDebugSession extends LoggingDebugSession {
	private _variableHandles = new Handles<'locals' | 'params' | 'upvalues' | 'globals' | LuauVariable>();
	private _configurationDone = new Subject();
	private _variables = new Map<string, LuauVariable & { ref: number }>();

	private process?: childProcess.ChildProcess = undefined;

	private debuggerBuffer: string = "";
	private debuggerOutputBuffer: string = "";
	private debuggerOutputErrBuffer: string = "";
	private debuggerStatus: DebuggerStatus = DebuggerStatus.starting;
	private debuggerInputEvent = new EventEmitter();
	private debuggerOutputEvent = new EventEmitter();
	private debuggerStopped = new Subject();

	private exceptionFilters: DebugProtocol.ExceptionFilterOptions[] = [];
	private pendingException: boolean = false;
	private breakpoints: { [filePath: string]: DebugProtocol.SourceBreakpoint[] | undefined } = {};
	private pendingBreakpoints: boolean = false;
	private currentScope: number = 0;

	private currentCmd: string = "";

	public constructor() {
		super("zune-debug.txt");
		this.setDebuggerLinesStartAt1(true);
		this.setDebuggerColumnsStartAt1(true);
	}

	protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
		response.body = response.body || {};

		response.body.supportsConfigurationDoneRequest = true;
		response.body.supportsEvaluateForHovers = true;
		response.body.supportsTerminateRequest = true;

		response.body.supportsExceptionFilterOptions = true;
		response.body.exceptionBreakpointFilters = [
			{
				filter: 'UnhandledError',
				label: "Luau: Uncaught error",
				description: 'Breaks on unhandled luau errors',
				default: true,
				supportsCondition: false
			},
			{
				filter: 'HandledError',
				label: "Luau: Caught error",
				description: `Breaks on handled luau errors (includes pcall, xpcall, etc).`,
				default: false,
				supportsCondition: false,
			},
		];

		response.body.supportsExceptionInfoRequest = true;

		this.sendResponse(response);
		this.sendEvent(new InitializedEvent());
	}

	protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments): void {
		super.configurationDoneRequest(response, args);
		this._configurationDone.notify();
	}

	protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments, request?: DebugProtocol.Request): void {
		response.success = true;
		this.sendResponse(response);
	}

	protected async attachRequest(response: DebugProtocol.AttachResponse, args: IAttachRequestArguments) {
		return this.launchRequest(response, args);
	}

	protected async launchRequest(response: DebugProtocol.LaunchResponse, args: ILaunchRequestArguments) {
		await this._configurationDone.wait(5000);

		const cwd = args.cwd;
		const processOptions: childProcess.SpawnOptions = {
			env: Object.assign({}, process.env),
			cwd,
			shell: true,
		};

		const processArgs = ["debug", "--once", ...args.debuggerArgs || [], args.program, ...args.args || []];
		this.process = childProcess.spawn(args.debuggerPath, processArgs, processOptions);

		console.log(`launching \`${args.debuggerPath} ${processArgs.join(" ")}\` from "${cwd}"`);

		assert.ok(this.process.stdout);
		assert.ok(this.process.stderr);
		this.process.stdout.on("data", data => { this.sendOutput(`${data}`, OutputKind.stdout); });
		this.process.stderr.on("data", data => { void this.onRecieve(data); });

		this.process.on("exit", () => this.onTerminated());
		this.process.on("close", () => this.onTerminated());
		this.process.on("error", () => this.onTerminated());
		this.process.on("disconnect", () => this.onTerminated());

		this.debuggerInputEvent.on('event', async () => {
			this.debuggerStatus = DebuggerStatus.stopped;
			this.debuggerStopped.notify();
		});

		this.debuggerOutputEvent.on('event', async (msg: string) => {
			var result;
			try {
				result = JSON.parse(msg);
			} catch (error) {
				return;
			}
			if (typeof result !== "object") {
				return;
			}
			if ('break' in result && typeof result.break === "number") {
				var reason = "breakpoint";
				if (result.break === 1) {
					reason = "breakpoint";
				} else if (result.break === 2) {
					reason = "step";
				} else if (result.break === 3 || result.break === 4) {
					reason = "exception";
				}

				const evt: DebugProtocol.StoppedEvent = new StoppedEvent(reason, 1);
				evt.body.allThreadsStopped = true;
				this.sendEvent(evt);
			}
		});

		await this.debuggerStopped.wait();

		await this.updateBreakpoints();

		if (this.debuggerStatus !== DebuggerStatus.stopped) {
			response.body = "Debugger spawned but did not report back any information";
			response.message = "Failed to start debugger (no response from debugger)";
			response.success = false;
			this.process?.kill("SIGKILL");
		} else {
			const mode = JSON.parse(await this.commandResult(`output json`));
			if (typeof mode !== "object" || !('mode' in mode) || mode.mode !== "json") {
				response.body = "Debugger responded but did not return in JSON mode";
				response.message = "Failed to start debugger (debugger bad setup)";
				response.success = false;
			}
		}

		this.sendResponse(response);

		if (!response.success) {
			return;
		}

		if (!args.stopOnEntry) {
			this.command(`run`);
		} else {
			const evt: DebugProtocol.StoppedEvent = new StoppedEvent("entry");
			evt.body.allThreadsStopped = true;
			this.sendEvent(evt);
		}
	}

	async updateBreakpoints() {
		if (this.pendingBreakpoints) {
			this.pendingBreakpoints = false;
			for (const filePath in this.breakpoints) {
				const breakpoints = this.breakpoints[filePath];
				if (!breakpoints) {
					continue;
				}
				for (const breakpoint of breakpoints) {
					await this.setBreakpoint(filePath, breakpoint);
				}
			}
		}
		if (this.pendingException) {
			this.pendingException = false;
			await this.commandResult(`exception HandledError ${this.exceptionFilters.find((f) => f.filterId === 'HandledError') !== undefined}`);
			await this.commandResult(`exception UnhandledError ${this.exceptionFilters.find((f) => f.filterId === 'UnhandledError') !== undefined}`);
		}
	}

	private setBreakpoint(filePath: string, breakpoint: DebugProtocol.SourceBreakpoint) {
		return this.commandResult(`break add ${filePath}:${breakpoint.line}`);
	}

	private deleteBreakpoint(filePath: string, breakpoint: DebugProtocol.SourceBreakpoint) {
		return this.commandResult(`break rm ${filePath}:${breakpoint.line}`);
	}

	protected async setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): Promise<void> {
		const filePath = args.source.path as string;

		if (this.process !== null && this.debuggerStatus === DebuggerStatus.stopped) {
			const oldbps = this.breakpoints[filePath];
			if (oldbps) {
				for (const breakpoint of oldbps) {
					await this.deleteBreakpoint(filePath, breakpoint);
				}
			}

			if (args.breakpoints) {
				for (const breakpoint of args.breakpoints) {
					await this.setBreakpoint(filePath, breakpoint);
				}
			}
		} else {
			this.pendingBreakpoints = true;
		}

		this.breakpoints[filePath] = args.breakpoints;

		response.body = {
			breakpoints: (args.breakpoints)
				? args.breakpoints.map(breakpoint => new Breakpoint(true, breakpoint.line))
				: [],
		};
		this.sendResponse(response);
	}

	protected async setExceptionBreakPointsRequest(response: DebugProtocol.SetExceptionBreakpointsResponse, args: DebugProtocol.SetExceptionBreakpointsArguments): Promise<void> {
		if (args.filterOptions) {
			this.exceptionFilters = args.filterOptions;
		}
		this.pendingException = true;
		this.sendResponse(response);
	}

	protected async exceptionInfoRequest(response: DebugProtocol.ExceptionInfoResponse, args: DebugProtocol.ExceptionInfoArguments) {
		const exception = JSON.parse(await this.commandResult(`exception`)) as DebuggerExceptionInfo;
		const frames = JSON.parse(await this.commandResult(`trace 0`)) as DebuggerStackFrame[];

		var stackframes = "";
		for (const frame of frames) {
			stackframes += `${frame.name || (frame.context === 0 ? "(entry)" : "(?)")} at ${Buffer.from(frame.src, 'base64').toString()}${frame.line > 0 ? `:${frame.line}` : ""}\n`;
		}

		response.body = {
			exceptionId: (exception.kind === 3) ? 'Runtime Handled Error' : 'Runtime Unhandled Error',
			description: (exception.reason) ? Buffer.from(exception.reason, 'base64').toString() : '(unknown reason)',
			breakMode: (exception.kind === 3) ? "userUnhandled" : "unhandled",
			details: {
				typeName: (exception.type) ? exception.type : '(unknown type)',
				stackTrace: stackframes,
			}
		};
		this.sendResponse(response);
	}

	protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
		response.body = {
			threads: [
				new Thread(1, "main thread"),
			]
		};
		this.sendResponse(response);
	}

	protected async stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): Promise<void> {
		var frames = JSON.parse(await this.commandResult(`trace ${args.levels || 0}`)) as DebuggerStackFrame[];
		if (typeof frames !== "object") {
			response.success = false;
			response.message = "Failed to get stack trace";
			this.sendResponse(response);
			return;
		}

		if (frames.length === 0) {
			response.body = {
				stackFrames: []
			};
			this.sendResponse(response);
			return;
		}

		var shift = 0;
		while (frames[0] && frames[0].context !== 0) {
			frames.shift();
			shift++;
		}

		const stackframes = frames.map((f, ix) => {
			const src = Buffer.from(f.src, 'base64').toString();
			if (f.context === 0 && f.src.length > 0 && f.src.charAt(0) !== '[') {
				const sf: DebugProtocol.StackFrame = new StackFrame(shift + ix, f.name || "(entry)", new Source(basename(src), src, undefined, undefined), this.convertDebuggerLineToClient(f.line));
				return sf;
			} else {
				return new StackFrame(shift + ix, f.name || "(entry)", new Source(src, undefined, undefined, undefined), this.convertDebuggerLineToClient(f.line));
			}
		});

		response.body = {
			stackFrames: stackframes,
			// totalFrames: stackframes.length,
		};
		this.sendResponse(response);
	}

	protected async scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): Promise<void> {
		this._variables.clear();
		this._variableHandles.reset();
		const scopes: Scope[] = [
			new Scope("Locals", this._variableHandles.create("locals"), false),
			new Scope("Params", this._variableHandles.create("params"), false),
			new Scope("Upvalues", this._variableHandles.create("upvalues"), true),
			new Scope("Globals", this._variableHandles.create("globals"), true)
		];
		this.currentScope = args.frameId;
		response.body = { scopes };
		this.sendResponse(response);
	}

	displayValue(value: string, type: string): string {
		switch (type) {
			case "string":
				return `"${value}"`;
			case "number":
			case "boolean":
			case "literal":
				return value;
			default:
				return `<${value}>`;
		}
	}

	protected async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments, request?: DebugProtocol.Request): Promise<void> {
		let paramIndex = 0;
		let varargIndex = 0;

		const variable = this._variableHandles.get(args.variablesReference);
		if (typeof variable === "string") {
			const locals: DebuggerVariableInfo[] = JSON.parse(await this.commandResult(`${variable} list ${this.currentScope}`));
			var variables: DebugProtocol.Variable[] = [];
			for (const value of locals) {
				let rawKey = (variable === "globals") ? Buffer.from(value.key, 'base64').toString() : value.key;
				rawKey = this.displayValue(rawKey, value.key_type);
				let rawValue = Buffer.from(value.value, 'base64').toString();
				if (variable === "params") {
					if (rawKey === "var") {
						rawKey = `var_arg${varargIndex++}`;
					} else {
						rawKey = `arg${paramIndex++}`;
					}
				}
				variables.push({
					name: rawKey,
					value: this.displayValue(rawValue, value.value_type),
					type: value.value_type,
					variablesReference: value.value_type === "table" ? this._variableHandles.create({
						id: value.id,
						value: value.value,
						type: value.value_type,
						parent: args.variablesReference,
					}) : 0,
				});
				if (variable === "locals" || variable === "upvalues") {
					this._variables.set(rawKey, {
						id: value.id,
						value: value.value,
						type: value.value_type,
						parent: args.variablesReference,
						ref: variables[variables.length - 1].variablesReference,
					});
				}
			}
			response.body = { variables };
		} else if (variable) {
			var variables: DebugProtocol.Variable[] = [];
			var luauVariables: LuauVariable[] = [];
			luauVariables.push(variable);
			var ctxVariable = variable;
			var context = "locals";
			while (ctxVariable) {
				const parent = this._variableHandles.get(ctxVariable.parent);
				if (typeof parent === 'object') {
					luauVariables.push(parent);
					ctxVariable = parent;
				} else {
					context = parent as string;
					break;
				}
			}
			luauVariables.reverse();

			var cmd = `${context} list ${this.currentScope} `;
			for (var i = 0; i < luauVariables.length; i++) {
				if (i > 0) {
					cmd += ',';
				}
				cmd += `${luauVariables[i].id}`;
			}
			const locals: DebuggerVariableInfo[] = JSON.parse(await this.commandResult(cmd));
			for (const value of locals) {
				const rawKey = Buffer.from(value.key, 'base64').toString();
				const rawValue = Buffer.from(value.value, 'base64').toString();
				variables.push({
					name: this.displayValue(rawKey, value.key_type),
					value: this.displayValue(rawValue, value.value_type),
					type: value.value_type,
					variablesReference: value.value_type === "table" ? this._variableHandles.create({
						id: value.id,
						value: value.value,
						type: value.value_type,
						parent: args.variablesReference,
					}) : 0,
				});
				if (context === "locals" || context === "upvalues") {
					this._variables.set(rawKey, {
						id: value.id,
						value: value.value,
						type: value.value_type,
						parent: args.variablesReference,
						ref: variables[variables.length - 1].variablesReference,
					});
				}
			}
			response.body = { variables };
		}

		this.sendResponse(response);
	}

	protected async continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): Promise<void> {
		await this.updateBreakpoints();
		await this.command("run");
		this.sendResponse(response);
	}

	protected async nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): Promise<void> {
		await this.updateBreakpoints();
		await this.commandResult(`next`);
		this.sendResponse(response);
	}

	protected async stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): Promise<void> {
		await this.updateBreakpoints();
		await this.commandResult(`step`);
		this.sendResponse(response);
	}

	protected async stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): Promise<void> {
		await this.updateBreakpoints();
		await this.commandResult(`stepout`);
		this.sendResponse(response);
	}

	protected async evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): Promise<void> {
		const expression = args.expression;
		const variable = this._variables.get(expression);
		if (variable && args.frameId === this.currentScope) {
			const rawValue = Buffer.from(variable.value, 'base64').toString();
			response.body = {
				result: variable.type === "string" ? `"${rawValue}"` : rawValue,
				variablesReference: variable.ref
			};
		}

		this.sendResponse(response);
	}

	protected terminateRequest(
		response: DebugProtocol.TerminateResponse,
		args: DebugProtocol.TerminateArguments
	): void {
		this.process?.kill("SIGKILL");

		response.success = true;

		this.sendResponse(response);
	}

	private onTerminated() {
		if (!this.process) {
			return;
		}
		this.process = undefined;
		this.sendEvent(new TerminatedEvent());
	}

	private sendOutput(msg: string, kind: OutputKind) {
		switch (kind) {
			case OutputKind.stdout:
				this.debuggerOutputBuffer += msg;
				var index = this.debuggerOutputBuffer.indexOf("\n");
				while (index >= 0) {
					const sub = this.debuggerOutputBuffer.substring(0, index + 1);
					this.sendEvent(new OutputEvent(sub, "stdout"));
					this.debuggerOutputBuffer = this.debuggerOutputBuffer.substring(index + 1);
					index = this.debuggerOutputBuffer.indexOf("\n");
				}
				break;
			case OutputKind.stderr:
				this.debuggerOutputErrBuffer += msg;
				var index = this.debuggerOutputErrBuffer.indexOf("\n");
				while (index >= 0) {
					const sub = this.debuggerOutputErrBuffer.substring(0, index + 1);
					this.sendEvent(new OutputEvent(sub, "stderr"));
					this.debuggerOutputErrBuffer = this.debuggerOutputErrBuffer.substring(index + 1);
					index = this.debuggerOutputErrBuffer.indexOf("\n");
				}
				break;
		}
	}

	private onRecieve(data: unknown) {
		const str: string = data instanceof Buffer ? data.toString() : typeof data === "string" ? data : `${data}`;
		this.debuggerBuffer += str;

		if (this.debuggerBuffer.length === 0) {
			return;
		}

		if (this.currentCmd.length > 0) {
			const cutoff = Math.min(this.debuggerBuffer.length, this.currentCmd.length);
			if (cutoff === 0) {
				return;
			}
			this.currentCmd = this.currentCmd.substring(cutoff);
			this.debuggerBuffer = this.debuggerBuffer.substring(cutoff);
			if (this.debuggerBuffer.length > 0) {
				this.onRecieve("");
			}
			return;
		}

		const index = this.debuggerBuffer.indexOf(`\x1b`);
		if (index === -1) {
			this.sendOutput(this.debuggerBuffer, OutputKind.stderr);
			this.debuggerBuffer = "";
			return;
		}

		const cmd = this.debuggerBuffer.substring(index);
		if (index > 0) {
			this.sendOutput(this.debuggerBuffer.substring(0, index), OutputKind.stderr);
			this.debuggerBuffer = cmd;
		}

		var matched = false;
		if (cmd.startsWith(INPUT_TAG)) {
			this.debuggerInputEvent.emit('event');
			this.debuggerBuffer = "";
			matched = true;
		} else if (cmd.startsWith(OUTPUT_TAG)) {
			const index = cmd.indexOf(`\n`);
			if (index >= 0) {
				const output = cmd.substring(OUTPUT_TAG.length, index);
				this.debuggerOutputEvent.emit('event', output);
				this.debuggerBuffer = cmd.substring(index + 1);
				this.onRecieve("");
				return;
			}
			matched = true;
		}

		if (!matched && cmd.length >= LARGEST_TAG_SIZE) {
			this.sendOutput(cmd[0], OutputKind.stderr);
			this.debuggerBuffer = cmd.substring(1);
			this.onRecieve("");
		}
	}

	private async command(cmd: string): Promise<void> {
		assert.ok(this.process, "process is undefined");
		while (this.debuggerStatus === DebuggerStatus.command || this.debuggerStatus !== DebuggerStatus.stopped) {
			await this.debuggerStopped.wait();
		}

		this.debuggerStatus = DebuggerStatus.command;

		if (cmd.startsWith("run") || cmd.startsWith("next") || cmd.startsWith("step") || cmd.startsWith("stepout")) {
			this.debuggerStatus = DebuggerStatus.running;
		}

		const write = `${cmd}\n`;
		this.currentCmd = write;
		assert.ok(this.process.stdin);
		this.process.stdin.write(write);
	}

	private async commandResult(cmd: string): Promise<string> {
		await this.command(cmd);
		return new Promise(resolve => this.debuggerOutputEvent.once('event', resolve));
	}
}

