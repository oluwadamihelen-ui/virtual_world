export interface Box { minX: number; maxX: number; minZ: number; maxZ: number }
export interface Gate extends Box { gate: string }
export interface Colliders { boxes: Box[]; gates: Gate[] }
export interface Bounds { minX: number; maxX: number; minZ: number; maxZ: number }
export interface Body { x: number; z: number; ry: number; moving: boolean }
export interface MoveInput { dx: number; dz: number; run?: boolean }
export const PLAYER_RADIUS: number;
export const WALK_SPEED: number;
export const RUN_SPEED: number;
export const WALL: number;
export function buildingBoxes(b: any): { walls: Box[]; gate: Box | null; frontZ?: number };
export function buildColliders(world: any): Colliders;
export function isBlocked(x: number, z: number, c: Colliders, hasGate: ((g: string) => boolean) | undefined, bounds: Bounds): boolean;
export function stepPlayer<T extends Body>(p: T, input: MoveInput, dt: number, c: Colliders, hasGate: ((g: string) => boolean) | undefined, bounds: Bounds): T;
export function dist2(ax: number, az: number, bx: number, bz: number): number;
export function gameClock(nowMs: number): { hour: number; dayIndex: number };
