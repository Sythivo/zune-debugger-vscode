import {
	LoggingDebugSession,
	InitializedEvent, TerminatedEvent, OutputEvent,
	Thread, StackFrame, Scope, Source, Handles, Breakpoint,
	StoppedEvent,
} from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import { basename } from 'path-browserify';
import { Subject } from 'await-notify';
import { EventEmitter } from 'events';
import * as childProcess from "child_process";
import * as assert from 'assert';
import * as path from 'path';
import * as net from 'net';
import { ZstdCodec } from 'zstd-codec';

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
	executing,
	stopped,
}

export enum MessageType {
	Paused = 0,
	Break = 1,
	Result = 2,
	Error = 3,
	Continued = 4
}

export enum Command {
	exit = 1,
	break = 2,
	trace = 6, // '\n' input frames
	step = 7,
	step_out = 8,
	step_instruction = 9,
	next = 10,
	locals = 11, // '\n' input frames
	params = 12, // '\n' input frames
	upvalues = 13, // '\n' input frames
	globals = 14, // '\n' input frames
	run = 15,
	restart = 16,
	exception = 18, // '\n' input frames
}

export enum CommandBreak {
	add = 1, // '\n' input frames
	remove = 2 // '\n' input frames
}

export enum CommandLocals {
	list = 1 // '\n' input frames
}

function createCommand(cmd: Command, args?: string): Buffer {
	const buffer = Buffer.allocUnsafe(1 + (args ? args.length + 1 : 0));
	buffer.writeUInt8(cmd, 0);
	if (typeof args !== "undefined") {
		buffer.write(args + "\n", 1, args.length + 1, undefined);
	}
	return buffer;
}

function createCommandSub(cmd: Command, sub: CommandBreak | CommandLocals, args?: string): Buffer {
	const buffer = Buffer.allocUnsafe(1 + 1 + (args ? args.length + 1 : 0));
	buffer.writeUInt8(cmd, 0);
	buffer.writeUInt8(sub, 1);
	if (typeof args !== "undefined") {
		buffer.write(args + "\n", 2, args.length + 1, undefined);
	}
	return buffer;
}

type DebuggerStackFrame = { name?: string, src: string, line: number, context: number };
type DebuggerExceptionInfo = { reason?: string, type?: string, kind: number };
type DebuggerVariableValue = { value: string, type: string, zbase64?: string };
type DebuggerVariableInfo = { id: number, key: DebuggerVariableValue, value: DebuggerVariableValue };

export class ZuneDebugSession extends LoggingDebugSession {
	private _variableHandles = new Handles<Command | LuauVariable>();
	private _configurationDone = new Subject();
	private _variables = new Map<string, LuauVariable & { ref: number }>();
	private _memoryReferences: { [ref: string]: { uncompressed?: Buffer, zbase64: string } } = {};
	private _memoryRefCount: number = 0;
	private _zstd: any;

	private process?: childProcess.ChildProcess = undefined;
	private processCwd: string = "";
	private debugServer?: net.Server;
	private debugSocket?: net.Socket;

	private zuneVersion?: string = undefined;
	private luauVersion?: string = undefined;

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
		response.body.supportsReadMemoryRequest = true;

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

		args.supportsVariableType = true;
		args.supportsMemoryReferences = true;

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

		this._zstd = new (await new Promise<any>(resolve => ZstdCodec.run(zstd => resolve(zstd)))).Simple();

		const cwd = args.cwd;
		const processOptions: childProcess.SpawnOptions = {
			env: Object.assign({}, process.env),
			cwd,
			shell: true,
		};

		this.debugServer = net.createServer((socket) => {
			this.debugSocket = socket;
			console.log('debug client connected');
			socket.on('data', (data) => this.onRecieve(data));

			socket.on('end', () => {
				console.log('debug client disconnected');
				this.onTerminated();
			});

			socket.on('error', (err) => {
				console.error('Connection error:', err.message);
			});
		});

		const port = await new Promise<number>((resolve) => this.debugServer?.listen(0, '127.0.0.1', () => {
			resolve((this.debugServer?.address() as net.AddressInfo).port);
		}));

		const processArgs = ["debug", `--ipc-port=${port}`, "--once", ...args.debuggerArgs || [], args.program, ...args.args || []];
		this.process = childProcess.spawn(args.debuggerPath, processArgs, processOptions);
		this.processCwd = cwd;

		console.log(`launching \`${args.debuggerPath} ${processArgs.join(" ")}\` from "${cwd}"`);

		assert.ok(this.process.stdout);
		assert.ok(this.process.stderr);
		this.process.stdout.on("data", data => { this.sendOutput(`${data}`, OutputKind.stdout); });
		this.process.stderr.on("data", data => { this.sendOutput(`${data}`, OutputKind.stderr); });

		this.process.on("exit", () => this.onTerminated());
		this.process.on("close", () => this.onTerminated());
		this.process.on("error", () => this.onTerminated());
		this.process.on("disconnect", () => this.onTerminated());

		this.debuggerInputEvent.on('event', async () => {
			this.debuggerStatus = DebuggerStatus.stopped;
			this.debuggerStopped.notify();
		});

		await this.debuggerStopped.wait();

		console.log(this.zuneVersion);
		console.log(this.luauVersion);

		await this.updateBreakpoints();

		if (this.debuggerStatus !== DebuggerStatus.stopped) {
			response.body = "Debugger spawned but did not report back any information";
			response.message = "Failed to start debugger (no response from debugger)";
			response.success = false;
			this.process?.kill("SIGKILL");
		}

		this.sendResponse(response);

		if (!response.success) {
			return;
		}

		if (!args.stopOnEntry) {
			this.command(createCommand(Command.run));
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
			await this.commandResult(createCommand(Command.exception, `HandledError ${this.exceptionFilters.find((f) => f.filterId === 'HandledError') !== undefined}`));
			await this.commandResult(createCommand(Command.exception, `UnhandledError ${this.exceptionFilters.find((f) => f.filterId === 'UnhandledError') !== undefined}`));
		}
	}

	private setBreakpoint(filePath: string, breakpoint: DebugProtocol.SourceBreakpoint) {
		return this.commandResult(createCommandSub(Command.break, CommandBreak.add, `${filePath}:${breakpoint.line}`));
	}

	private deleteBreakpoint(filePath: string, breakpoint: DebugProtocol.SourceBreakpoint) {
		return this.commandResult(createCommandSub(Command.break, CommandBreak.remove, `${filePath}:${breakpoint.line}`));
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
		const exception = JSON.parse(await this.commandResult(createCommand(Command.exception, " "))) as DebuggerExceptionInfo;
		const frames = JSON.parse(await this.commandResult(createCommand(Command.trace, `0`))) as DebuggerStackFrame[];

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
		var frames = JSON.parse(await this.commandResult(createCommand(Command.trace, `${args.levels || 0}`))) as DebuggerStackFrame[];
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
				const sf: DebugProtocol.StackFrame = new StackFrame(shift + ix, f.name || "(entry)", new Source(basename(src), path.resolve(this.processCwd, src), undefined, undefined), this.convertDebuggerLineToClient(f.line));
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
		this._memoryReferences = {};
		this._memoryRefCount = 0;
		const scopes: Scope[] = [
			new Scope("Locals", this._variableHandles.create(Command.locals), false),
			new Scope("Params", this._variableHandles.create(Command.params), false),
			new Scope("Upvalues", this._variableHandles.create(Command.upvalues), true),
			new Scope("Globals", this._variableHandles.create(Command.globals), true)
		];
		this.currentScope = args.frameId;
		response.body = { scopes };
		this.sendResponse(response);
	}

	protected async readMemoryRequest(response: DebugProtocol.ReadMemoryResponse, { offset = 0, count, memoryReference }: DebugProtocol.ReadMemoryArguments) {
		const mem = this._memoryReferences[memoryReference];
		if (!mem) {
			response.success = false;
			response.message = "Invalid memory reference";
			this.sendResponse(response);
			return;
		}

		if (!mem.uncompressed) {
			const raw = Buffer.from(mem.zbase64, 'base64');
			mem.uncompressed = Buffer.from(this._zstd.decompress(raw));
		}

		const memory = mem.uncompressed.subarray(
			Math.min(offset, mem.uncompressed.length),
			Math.min(offset + count, mem.uncompressed.length)
		);

		response.body = {
			address: offset.toString(),
			data: memory.toString('base64'),
			unreadableBytes: count - memory.length,
		};

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
		if (typeof variable === "object") {
			var variables: DebugProtocol.Variable[] = [];
			var luauVariables: LuauVariable[] = [];
			luauVariables.push(variable);
			var ctxVariable = variable;
			var context: Command = Command.locals;
			while (ctxVariable) {
				const parent = this._variableHandles.get(ctxVariable.parent);
				if (typeof parent === 'object') {
					luauVariables.push(parent);
					ctxVariable = parent;
				} else {
					context = parent;
					break;
				}
			}
			luauVariables.reverse();

			var cmd = `${this.currentScope} `;
			for (var i = 0; i < luauVariables.length; i++) {
				if (i > 0) {
					cmd += ',';
				}
				cmd += `${luauVariables[i].id}`;
			}
			const locals: DebuggerVariableInfo[] = JSON.parse(await this.commandResult(createCommandSub(context, CommandLocals.list, cmd)));
			for (const value of locals) {
				const rawKey = Buffer.from(value.key.value, 'base64').toString();
				const rawValue = Buffer.from(value.value.value, 'base64').toString();
				var memoryReference: string | undefined = undefined;
				if (value.value.zbase64) {
					memoryReference = `${rawKey}.${this._memoryRefCount}`;
					this._memoryRefCount++;
				}
				variables.push({
					name: this.displayValue(rawKey, value.key.type),
					value: this.displayValue(rawValue, value.value.type),
					type: value.value.type,
					variablesReference: value.value.type === "table" ? this._variableHandles.create({
						id: value.id,
						value: value.value.value,
						type: value.value.type,
						parent: args.variablesReference,
					}) : 0,
					memoryReference: memoryReference,
				});
				if (memoryReference) {
					this._memoryReferences[memoryReference] = { zbase64: value.value.zbase64! };
				}
				if (context === Command.locals || context === Command.upvalues) {
					this._variables.set(rawKey, {
						id: value.id,
						value: value.value.value,
						type: value.value.type,
						parent: args.variablesReference,
						ref: variables[variables.length - 1].variablesReference,
					});
				}
			}
			response.body = { variables };
		} else if (variable) {
			const locals: DebuggerVariableInfo[] = JSON.parse(await this.commandResult(createCommandSub(variable, CommandLocals.list, `${this.currentScope}`)));
			var variables: DebugProtocol.Variable[] = [];
			for (const value of locals) {
				let rawKey = (variable === Command.globals) ? Buffer.from(value.key.value, 'base64').toString() : value.key.value;
				rawKey = this.displayValue(rawKey, value.key.type);
				let rawValue = Buffer.from(value.value.value, 'base64').toString();
				if (variable === Command.params) {
					if (rawKey === "var") {
						rawKey = `var_arg${varargIndex++}`;
					} else {
						rawKey = `arg${paramIndex++}`;
					}
				}
				var memoryReference: string | undefined = undefined;
				if (value.value.zbase64) {
					memoryReference = `${rawKey}.${this._memoryRefCount}`;
					this._memoryRefCount++;
				}
				variables.push({
					name: rawKey,
					value: this.displayValue(rawValue, value.value.type),
					type: value.value.type,
					variablesReference: value.value.type === "table" ? this._variableHandles.create({
						id: value.id,
						value: value.value.value,
						type: value.value.type,
						parent: args.variablesReference,
					}) : 0,
					memoryReference: memoryReference,
				});
				if (memoryReference) {
					this._memoryReferences[memoryReference] = { zbase64: value.value.zbase64! };
				}
				if (variable === Command.locals || variable === Command.upvalues) {
					this._variables.set(rawKey, {
						id: value.id,
						value: value.value.value,
						type: value.value.type,
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
		await this.command(createCommand(Command.run));
		this.sendResponse(response);
	}

	protected async nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): Promise<void> {
		await this.updateBreakpoints();
		await this.commandResult(createCommand(Command.next));
		this.sendResponse(response);
	}

	protected async stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): Promise<void> {
		await this.updateBreakpoints();
		await this.commandResult(createCommand(Command.step));
		this.sendResponse(response);
	}

	protected async stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): Promise<void> {
		await this.updateBreakpoints();
		await this.commandResult(createCommand(Command.step_out));
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

	private onRecieve(data?: unknown) {
		if (data) {
			const str: string = data instanceof Buffer ? data.toString() : typeof data === "string" ? data : `${data}`;
			this.debuggerBuffer += str;
		}

		if (this.debuggerBuffer.length === 0) {
			return;
		}

		if (this.zuneVersion === undefined || this.luauVersion === undefined) {
			const line = this.debuggerBuffer.indexOf(`\n`);
			if (line >= 0) {
				const version_string = this.debuggerBuffer.substring(0, line);
				this.debuggerBuffer = this.debuggerBuffer.substring(line + 1);
				if (this.zuneVersion === undefined) {
					this.zuneVersion = version_string;
					this.onRecieve();
					return;
				}
				if (this.luauVersion === undefined) {
					this.luauVersion = version_string;
					this.onRecieve();
					return;
				}
			}
		}

		const type: MessageType = this.debuggerBuffer.charCodeAt(0);

		switch (type) {
			case MessageType.Paused:
				this.debuggerBuffer = this.debuggerBuffer.substring(1);
				this.debuggerInputEvent.emit('event');
				this.onRecieve();
				break;
			case MessageType.Break:
				// consume until `\n`
				const breakIndex = this.debuggerBuffer.indexOf(`\n`);
				if (breakIndex >= 0) {
					const breakInfo = this.debuggerBuffer.substring(1, breakIndex);
					this.debuggerBuffer = this.debuggerBuffer.substring(breakIndex + 1);
					const result = JSON.parse(breakInfo);
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
					this.onRecieve();
				}
				break;
			case MessageType.Result:
				const index = this.debuggerBuffer.indexOf(`\n`);
				if (index >= 0) {
					const output = this.debuggerBuffer.substring(1, index);
					this.debuggerBuffer = this.debuggerBuffer.substring(index + 1);
					this.debuggerOutputEvent.emit('event', output);
					this.debuggerInputEvent.emit('event');
					this.onRecieve();
				}
				break;
			case MessageType.Continued:
				this.debuggerBuffer = this.debuggerBuffer.substring(1);
				this.onRecieve();
				break;
			case MessageType.Error:
				const errIndex = this.debuggerBuffer.indexOf(`\n`);
				if (errIndex >= 0) {
					const output = this.debuggerBuffer.substring(1, errIndex);
					this.debuggerBuffer = this.debuggerBuffer.substring(errIndex + 1);
					console.error(`debug client error: ${output}`);
					this.debuggerInputEvent.emit('event');
					this.onRecieve();
				}
				break;
			default:
				console.error(`unknown message type: ${type}`);
				this.debuggerBuffer = "";
				break;
		}
	}

	private async command(cmd: Buffer): Promise<void> {
		assert.ok(this.process, "process is undefined");
		assert.ok(this.debugSocket, "socket is undefined");
		if (this.debuggerStatus !== DebuggerStatus.stopped) {
			await this.debuggerStopped.wait();
		}

		this.debuggerStatus = DebuggerStatus.executing;

		this.debugSocket.write(cmd, (err) => {
			if (err) {
				console.error("failed to send command to debugger client:", err);
			}
		});
	}

	private async commandResult(cmd: Buffer): Promise<string> {
		await this.command(cmd);
		return new Promise(resolve => this.debuggerOutputEvent.once('event', resolve));
	}
}

