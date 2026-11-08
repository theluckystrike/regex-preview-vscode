// Catastrophic backtracking: (a+)+$ against 30 "a" and a "!" takes minutes in a plain engine.
export const EVIL = /(a+)+$/;
export const EVIL_INPUT = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!';
export const ZERO_WIDTH = /(?=a)|\b/g;
export const BROKEN = new RegExp('(unclosed[group');
