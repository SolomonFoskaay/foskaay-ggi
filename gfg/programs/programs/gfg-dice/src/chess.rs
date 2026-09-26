// chess.rs (M1A Chess core, Phase 1)
//
// The on-chain chess engine: board representation, full legal move generation,
// special moves (castling, en passant, promotion), end-condition detection, and
// perft. It is a module inside the SAME gfg program (one deploy, one IDL). This
// file adds NO instruction yet (Phase 2 wires the lifecycle); Phase 1 proves the
// engine with host-side perft tests against the standard perft positions.
//
// Piece encoding (u8):
//   0 empty
//   1..6  white P N B R Q K
//   7..12 black P N B R Q K
// Squares: rank*8 + file, file 0..7 = a..h, rank 0..7 = 1..8. White moves +8.
//
// Owner-locked rules live in architecture.json (M1A chess). This file is the
// engine only; it never computes rewards (M1 is reward-blind).

use anchor_lang::prelude::*;

pub const CHESS_SEED: &[u8] = b"gfgchess";

pub const EMPTY: u8 = 0;
pub const WP: u8 = 1;
pub const WN: u8 = 2;
pub const WB: u8 = 3;
pub const WR: u8 = 4;
pub const WQ: u8 = 5;
pub const WK: u8 = 6;
pub const BP: u8 = 7;
pub const BN: u8 = 8;
pub const BB: u8 = 9;
pub const BR: u8 = 10;
pub const BQ: u8 = 11;
pub const BK: u8 = 12;

pub const WHITE: u8 = 0;
pub const BLACK: u8 = 1;

// Castling rights bitmask.
pub const CR_WK: u8 = 1;
pub const CR_WQ: u8 = 2;
pub const CR_BK: u8 = 4;
pub const CR_BQ: u8 = 8;

pub const NO_EP: u8 = 255;

pub const STATUS_LOBBY: u8 = 0;
pub const STATUS_PLAYING: u8 = 1;
pub const STATUS_FINISHED: u8 = 2;

pub const RESULT_NONE: u8 = 255;
pub const RESULT_WHITE: u8 = 0;
pub const RESULT_BLACK: u8 = 1;
pub const RESULT_DRAW: u8 = 2;

pub const REASON_NONE: u8 = 0;
pub const REASON_CHECKMATE: u8 = 1;
pub const REASON_RESIGN: u8 = 2;
pub const REASON_TIMEOUT: u8 = 3;
pub const REASON_STALEMATE: u8 = 4;
pub const REASON_THREEFOLD: u8 = 5;
pub const REASON_FIFTY: u8 = 6;
pub const REASON_INSUFFICIENT: u8 = 7;
pub const REASON_AGREEMENT: u8 = 8;
pub const REASON_PLY_CAP: u8 = 9;

pub fn is_white(p: u8) -> bool { p >= WP && p <= WK }
pub fn is_black(p: u8) -> bool { p >= BP && p <= BK }
pub fn is_empty(p: u8) -> bool { p == EMPTY }
pub fn color_of(p: u8) -> u8 { if is_black(p) { BLACK } else { WHITE } }
pub fn kind_of(p: u8) -> u8 { if is_black(p) { p - 6 } else { p } }
pub fn make_piece(color: u8, kind: u8) -> u8 { if color == WHITE { kind } else { kind + 6 } }

#[inline]
pub fn file_of(sq: u8) -> i8 { (sq % 8) as i8 }
#[inline]
pub fn rank_of(sq: u8) -> i8 { (sq / 8) as i8 }
#[inline]
fn on_board(f: i8, r: i8) -> bool { f >= 0 && f < 8 && r >= 0 && r < 8 }
#[inline]
fn idx(f: i8, r: i8) -> usize { (r * 8 + f) as usize }

const KNIGHT_D: [(i8, i8); 8] = [(1, 2), (2, 1), (2, -1), (1, -2), (-1, -2), (-2, -1), (-2, 1), (-1, 2)];
const KING_D: [(i8, i8); 8] = [(1, 0), (1, 1), (0, 1), (-1, 1), (-1, 0), (-1, -1), (0, -1), (1, -1)];
const ROOK_D: [(i8, i8); 4] = [(1, 0), (-1, 0), (0, 1), (0, -1)];
const BISHOP_D: [(i8, i8); 4] = [(1, 1), (1, -1), (-1, 1), (-1, -1)];

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Move {
    pub from: u8,
    pub to: u8,
    pub promo: u8, // 0 none, else kind (2..5) of the promoted piece
}

pub const MAX_MOVES: usize = 256;

pub struct MoveList {
    pub moves: [Move; MAX_MOVES],
    pub len: usize,
}

impl MoveList {
    pub fn new() -> Self { MoveList { moves: [Move { from: 0, to: 0, promo: 0 }; MAX_MOVES], len: 0 } }
    #[inline]
    pub fn push(&mut self, m: Move) {
        if self.len < MAX_MOVES { self.moves[self.len] = m; self.len += 1; }
    }
    #[inline]
    pub fn get(&self, i: usize) -> Move { self.moves[i] }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub struct Position {
    pub squares: [u8; 64],
    pub side: u8,
    pub castling: u8,
    pub ep: u8,
    pub halfmove: u16,
    pub fullmove: u16,
}

impl Position {
    pub fn initial() -> Self {
        let mut s = [EMPTY; 64];
        // rank 1 (0-7): R N B Q K B N R
        s[0] = WR; s[1] = WN; s[2] = WB; s[3] = WQ; s[4] = WK; s[5] = WB; s[6] = WN; s[7] = WR;
        for f in 0..8 { s[8 + f] = WP; }
        for f in 0..8 { s[48 + f] = BP; }
        s[56] = BR; s[57] = BN; s[58] = BB; s[59] = BQ; s[60] = BK; s[61] = BB; s[62] = BN; s[63] = BR;
        Position { squares: s, side: WHITE, castling: CR_WK | CR_WQ | CR_BK | CR_BQ, ep: NO_EP, halfmove: 0, fullmove: 1 }
    }

    pub fn king_square(&self, color: u8) -> Option<u8> {
        let k = make_piece(color, WK);
        for i in 0..64 { if self.squares[i] == k { return Some(i as u8); } }
        None
    }
}

// ---------- attack detection ----------

/// Is `target` attacked by any piece of `by`?
pub fn is_attacked(squares: &[u8; 64], target: u8, by: u8) -> bool {
    let tf = file_of(target);
    let tr = rank_of(target);

    // Pawns.
    if by == WHITE {
        if tr >= 1 {
            if tf >= 1 && squares[idx(tf - 1, tr - 1)] == WP { return true; }
            if tf <= 6 && squares[idx(tf + 1, tr - 1)] == WP { return true; }
        }
    } else if tr <= 6 {
        if tf >= 1 && squares[idx(tf - 1, tr + 1)] == BP { return true; }
        if tf <= 6 && squares[idx(tf + 1, tr + 1)] == BP { return true; }
    }

    // Knights.
    let kn = make_piece(by, WN);
    for (df, dr) in KNIGHT_D {
        let f = tf + df; let r = tr + dr;
        if on_board(f, r) && squares[idx(f, r)] == kn { return true; }
    }

    // King.
    let kg = make_piece(by, WK);
    for (df, dr) in KING_D {
        let f = tf + df; let r = tr + dr;
        if on_board(f, r) && squares[idx(f, r)] == kg { return true; }
    }

    // Sliding: rook/queen on ranks and files.
    let rq = [make_piece(by, WR), make_piece(by, WQ)];
    for (df, dr) in ROOK_D {
        let mut f = tf + df; let mut r = tr + dr;
        while on_board(f, r) {
            let p = squares[idx(f, r)];
            if p != EMPTY { if p == rq[0] || p == rq[1] { return true; } break; }
            f += df; r += dr;
        }
    }
    // Sliding: bishop/queen on diagonals.
    let bq = [make_piece(by, WB), make_piece(by, WQ)];
    for (df, dr) in BISHOP_D {
        let mut f = tf + df; let mut r = tr + dr;
        while on_board(f, r) {
            let p = squares[idx(f, r)];
            if p != EMPTY { if p == bq[0] || p == bq[1] { return true; } break; }
            f += df; r += dr;
        }
    }
    false
}

pub fn in_check(pos: &Position, color: u8) -> bool {
    if let Some(ks) = pos.king_square(color) {
        is_attacked(&pos.squares, ks, 1 - color)
    } else {
        false
    }
}

// ---------- move generation ----------

fn push_pawn_moves(list: &mut MoveList, from: u8, to: u8, promo: bool) {
    if promo {
        for kind in [WN, WB, WR, WQ] {
            list.push(Move { from, to, promo: kind });
        }
    } else {
        list.push(Move { from, to, promo: 0 });
    }
}

pub fn generate_pseudo_legal(pos: &Position, list: &mut MoveList) {
    let us = pos.side;
    let them = 1 - us;
    let sq = &pos.squares;

    for i in 0..64u8 {
        let p = sq[i as usize];
        if p == EMPTY || color_of(p) != us { continue; }
        let k = kind_of(p);
        let f = file_of(i);
        let r = rank_of(i);

        match k {
            WP => {
                if us == WHITE {
                    let one = i + 8;
                    if i < 56 && sq[one as usize] == EMPTY {
                        push_pawn_moves(list, i, one, rank_of(one) == 7);
                        if r == 1 {
                            let two = i + 16;
                            if sq[two as usize] == EMPTY { list.push(Move { from: i, to: two, promo: 0 }); }
                        }
                    }
                    for (df, dr) in [(-1i8, 1i8), (1i8, 1i8)] {
                        let nf = f + df; let nr = r + dr;
                        if on_board(nf, nr) {
                            let t = idx(nf, nr) as u8;
                            let tp = sq[t as usize];
                            if (tp != EMPTY && color_of(tp) == them) || t == pos.ep {
                                push_pawn_moves(list, i, t, nr == 7);
                            }
                        }
                    }
                } else {
                    let one = i.wrapping_sub(8);
                    if i >= 8 && sq[one as usize] == EMPTY {
                        push_pawn_moves(list, i, one, rank_of(one) == 0);
                        if r == 6 {
                            let two = i - 16;
                            if sq[two as usize] == EMPTY { list.push(Move { from: i, to: two, promo: 0 }); }
                        }
                    }
                    for (df, dr) in [(-1i8, -1i8), (1i8, -1i8)] {
                        let nf = f + df; let nr = r + dr;
                        if on_board(nf, nr) {
                            let t = idx(nf, nr) as u8;
                            let tp = sq[t as usize];
                            if (tp != EMPTY && color_of(tp) == them) || t == pos.ep {
                                push_pawn_moves(list, i, t, nr == 0);
                            }
                        }
                    }
                }
            }
            WN => {
                for (df, dr) in KNIGHT_D {
                    let nf = f + df; let nr = r + dr;
                    if on_board(nf, nr) {
                        let t = idx(nf, nr);
                        let tp = sq[t];
                        if tp == EMPTY || color_of(tp) == them { list.push(Move { from: i, to: t as u8, promo: 0 }); }
                    }
                }
            }
            WB | WR | WQ => {
                let dirs: &[(i8, i8)] = match k {
                    WB => &BISHOP_D,
                    WR => &ROOK_D,
                    _ => &KING_D, // placeholder, replaced below
                };
                // Queen uses rook + bishop rays.
                if k == WQ {
                    for dirset in [&ROOK_D[..], &BISHOP_D[..]] {
                        for (df, dr) in dirset {
                            let mut nf = f + df; let mut nr = r + dr;
                            while on_board(nf, nr) {
                                let t = idx(nf, nr);
                                let tp = sq[t];
                                if tp == EMPTY { list.push(Move { from: i, to: t as u8, promo: 0 }); }
                                else { if color_of(tp) == them { list.push(Move { from: i, to: t as u8, promo: 0 }); } break; }
                                nf += df; nr += dr;
                            }
                        }
                    }
                } else {
                    for (df, dr) in dirs {
                        let mut nf = f + df; let mut nr = r + dr;
                        while on_board(nf, nr) {
                            let t = idx(nf, nr);
                            let tp = sq[t];
                            if tp == EMPTY { list.push(Move { from: i, to: t as u8, promo: 0 }); }
                            else { if color_of(tp) == them { list.push(Move { from: i, to: t as u8, promo: 0 }); } break; }
                            nf += df; nr += dr;
                        }
                    }
                }
            }
            WK => {
                for (df, dr) in KING_D {
                    let nf = f + df; let nr = r + dr;
                    if on_board(nf, nr) {
                        let t = idx(nf, nr);
                        let tp = sq[t];
                        if tp == EMPTY || color_of(tp) == them { list.push(Move { from: i, to: t as u8, promo: 0 }); }
                    }
                }
                // Castling.
                if us == WHITE && i == 4 {
                    if pos.castling & CR_WK != 0
                        && sq[5] == EMPTY && sq[6] == EMPTY
                        && !is_attacked(sq, 4, BLACK) && !is_attacked(sq, 5, BLACK) && !is_attacked(sq, 6, BLACK)
                    { list.push(Move { from: 4, to: 6, promo: 0 }); }
                    if pos.castling & CR_WQ != 0
                        && sq[1] == EMPTY && sq[2] == EMPTY && sq[3] == EMPTY
                        && !is_attacked(sq, 4, BLACK) && !is_attacked(sq, 3, BLACK) && !is_attacked(sq, 2, BLACK)
                    { list.push(Move { from: 4, to: 2, promo: 0 }); }
                } else if us == BLACK && i == 60 {
                    if pos.castling & CR_BK != 0
                        && sq[61] == EMPTY && sq[62] == EMPTY
                        && !is_attacked(sq, 60, WHITE) && !is_attacked(sq, 61, WHITE) && !is_attacked(sq, 62, WHITE)
                    { list.push(Move { from: 60, to: 62, promo: 0 }); }
                    if pos.castling & CR_BQ != 0
                        && sq[57] == EMPTY && sq[58] == EMPTY && sq[59] == EMPTY
                        && !is_attacked(sq, 60, WHITE) && !is_attacked(sq, 59, WHITE) && !is_attacked(sq, 58, WHITE)
                    { list.push(Move { from: 60, to: 58, promo: 0 }); }
                }
            }
            _ => {}
        }
    }
}

pub fn make_move(pos: &Position, m: Move) -> Position {
    let mut np = *pos;
    let s = &mut np.squares;
    let p = s[m.from as usize];
    let k = kind_of(p);
    let us = color_of(p);
    let them = 1 - us;
    let from_f = file_of(m.from);
    let to_f = file_of(m.to);
    let mut captured = s[m.to as usize];

    // En passant capture: pawn moves diagonally to the ep square (empty there).
    if k == WP && m.to == pos.ep && to_f != from_f && captured == EMPTY {
        let cap_sq = if us == WHITE { m.to - 8 } else { m.to + 8 };
        captured = s[cap_sq as usize];
        s[cap_sq as usize] = EMPTY;
    }

    s[m.to as usize] = p;
    s[m.from as usize] = EMPTY;

    // Promotion.
    if m.promo != 0 && k == WP {
        s[m.to as usize] = make_piece(us, m.promo);
    }

    // Castling: king moves two squares; move the rook.
    if k == WK && (m.to == 6 || m.to == 2) {
        if m.to == 6 { s[5] = s[7]; s[7] = EMPTY; }
        else { s[3] = s[0]; s[0] = EMPTY; }
    } else if k == WK && (m.to == 62 || m.to == 58) {
        if m.to == 62 { s[61] = s[63]; s[63] = EMPTY; }
        else { s[59] = s[56]; s[56] = EMPTY; }
    }

    // Update castling rights: a king move clears both for that side; a rook
    // move (from that corner, or a capture landing on it) clears the matching
    // right.
    let mut cr = pos.castling;
    if k == WK {
        if us == WHITE { cr &= !(CR_WK | CR_WQ); } else { cr &= !(CR_BK | CR_BQ); }
    }
    if m.from == 0 || m.to == 0 { cr &= !CR_WQ; }
    if m.from == 7 || m.to == 7 { cr &= !CR_WK; }
    if m.from == 56 || m.to == 56 { cr &= !CR_BQ; }
    if m.from == 63 || m.to == 63 { cr &= !CR_BK; }
    np.castling = cr;

    // En passant target on a double pawn push.
    if k == WP && (m.to as i16 - m.from as i16).abs() == 16 {
        np.ep = (m.from + m.to) / 2;
    } else {
        np.ep = NO_EP;
    }

    // Halfmove clock: reset on pawn move or capture.
    if k == WP || captured != EMPTY { np.halfmove = 0; } else { np.halfmove = pos.halfmove.saturating_add(1); }
    if us == BLACK { np.fullmove = pos.fullmove.saturating_add(1); }
    np.side = them;
    np
}

pub fn generate_legal_moves(pos: &Position, list: &mut MoveList) {
    let mut pseudo = MoveList::new();
    generate_pseudo_legal(pos, &mut pseudo);
    let us = pos.side;
    for i in 0..pseudo.len {
        let m = pseudo.get(i);
        let np = make_move(pos, m);
        if !in_check(&np, us) {
            list.push(m);
        }
    }
}

// ---------- end conditions ----------

pub fn has_legal_moves(pos: &Position) -> bool {
    let mut l = MoveList::new();
    generate_legal_moves(pos, &mut l);
    l.len > 0
}

pub fn is_checkmate(pos: &Position) -> bool {
    in_check(pos, pos.side) && !has_legal_moves(pos)
}

pub fn is_stalemate(pos: &Position) -> bool {
    !in_check(pos, pos.side) && !has_legal_moves(pos)
}

pub fn is_fifty_move(pos: &Position) -> bool {
    pos.halfmove >= 100
}

/// K vs K, K+minor vs K, K+B vs K+B with bishops on the same colour.
pub fn is_insufficient_material(pos: &Position) -> bool {
    let mut bishops_light = 0u8;
    let mut bishops_dark = 0u8;
    let mut knights = 0u8;
    let mut others = 0u8;
    for i in 0..64u8 {
        let p = pos.squares[i as usize];
        if p == EMPTY { continue; }
        let k = kind_of(p);
        match k {
            WK => {}
            WB => { if (file_of(i) + rank_of(i)) % 2 == 0 { bishops_light += 1; } else { bishops_dark += 1; } }
            WN => { knights += 1; }
            _ => { others += 1; }
        }
    }
    if others > 0 { return false; }
    let minors = bishops_light + bishops_dark + knights;
    if minors <= 1 { return true; }
    if knights == 0 && (bishops_light == 0 || bishops_dark == 0) { return true; }
    false
}

/// Deterministic position hash (FNV-1a over squares, side, castling, ep).
pub fn position_hash(pos: &Position) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for i in 0..64usize {
        h ^= pos.squares[i] as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h ^= pos.side as u64; h = h.wrapping_mul(0x100000001b3);
    h ^= pos.castling as u64; h = h.wrapping_mul(0x100000001b3);
    h ^= pos.ep as u64; h = h.wrapping_mul(0x100000001b3);
    h
}

// ---------- perft (tests / benchmark) ----------

pub fn perft(pos: &Position, depth: u32) -> u64 {
    if depth == 0 { return 1; }
    let mut l = MoveList::new();
    generate_legal_moves(pos, &mut l);
    if depth == 1 { return l.len as u64; }
    let mut nodes = 0u64;
    for i in 0..l.len {
        let np = make_move(pos, l.get(i));
        nodes += perft(&np, depth - 1);
    }
    nodes
}

// ---------- FEN (tests) ----------

pub fn parse_fen(fen: &str) -> Position {
    let parts: [&str; 6] = {
        let mut it = fen.split_whitespace();
        [
            it.next().unwrap_or(""),
            it.next().unwrap_or("w"),
            it.next().unwrap_or("-"),
            it.next().unwrap_or("-"),
            it.next().unwrap_or("0"),
            it.next().unwrap_or("1"),
        ]
    };
    let mut s = [EMPTY; 64];
    let mut rank: i8 = 7;
    let mut file: i8 = 0;
    for ch in parts[0].chars() {
        match ch {
            '/' => { rank -= 1; file = 0; }
            '1'..='8' => { file += (ch as u8 - b'0') as i8; }
            _ => {
                let p = match ch {
                    'P' => WP, 'N' => WN, 'B' => WB, 'R' => WR, 'Q' => WQ, 'K' => WK,
                    'p' => BP, 'n' => BN, 'b' => BB, 'r' => BR, 'q' => BQ, 'k' => BK,
                    _ => EMPTY,
                };
                if on_board(file, rank) { s[idx(file, rank)] = p; }
                file += 1;
            }
        }
    }
    let side = if parts[1] == "b" { BLACK } else { WHITE };
    let mut cr = 0u8;
    if parts[2].contains('K') { cr |= CR_WK; }
    if parts[2].contains('Q') { cr |= CR_WQ; }
    if parts[2].contains('k') { cr |= CR_BK; }
    if parts[2].contains('q') { cr |= CR_BQ; }
    let ep = if parts[3] == "-" {
        NO_EP
    } else {
        let b = parts[3].as_bytes();
        let f = (b[0] - b'a') as i8;
        let r = (b[1] - b'1') as i8;
        idx(f, r) as u8
    };
    let halfmove = parts[4].parse::<u16>().unwrap_or(0);
    let fullmove = parts[5].parse::<u16>().unwrap_or(1);
    Position { squares: s, side, castling: cr, ep, halfmove, fullmove }
}

// ---------- on-chain account (Phase 2 wires instructions) ----------

#[account]
pub struct ChessBoard {
    pub version: u8,
    pub game: u8,
    pub status: u8,
    pub seat_count: u8,
    pub result: u8,
    pub end_reason: u8,
    pub side_to_move: u8,
    pub castling: u8,
    pub ep: u8,
    pub check_flag: u8,
    pub seats: [Pubkey; 2],
    pub position: [u8; 64],
    pub clock_ms: [u64; 2],
    pub increment_ms: u64,
    pub turn_started_at: i64,
    pub started_at: i64,
    pub finished_at: i64,
    pub halfmove: u16,
    pub fullmove: u16,
    pub move_count: u32,
    pub last_hash: u64,
    pub history: [u64; 128],
    pub hist_len: u16,
    pub hist_pos: u16,
    pub draw_offer: u8,
    pub last_request_ref: u64,
    pub bump: u8,
}

impl ChessBoard {
    // Borsh-fixed layout length (no padding). Kept explicit so the Phase 2
    // `space = 8 + ChessBoard::LEN` is exact and the layout is stable.
    // history is a bounded 128-ply ring buffer (position hashes) for threefold
    // repetition; it fits the 4 KB stack frame, unlike a full move list.
    pub const LEN: usize = 1240;
}

// ---------- Phase 2: AI, apply/finish, contexts ----------

use crate::{PointsError, PlayerCore, CORE_SEED};
use ephemeral_rollups_sdk::anchor::{commit, delegate};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::MagicIntentBundleBuilder;

pub const CHESS_TAG: u8 = 1;
pub const AI_SEAT: u8 = 1;
pub const INITIAL_CASTLING: u8 = CR_WK | CR_WQ | CR_BK | CR_BQ;

/// Material score from the perspective of the side to move (positive is good
/// for the side to move). Kept simple to fit the ER compute budget.
pub fn evaluate(pos: &Position) -> i32 {
    let mut score = 0i32;
    for i in 0..64usize {
        let p = pos.squares[i];
        if p == EMPTY { continue; }
        let v = match kind_of(p) {
            WN => 320, WB => 330, WR => 500, WQ => 900, WK => 20000, _ => 100,
        };
        if color_of(p) == pos.side { score += v; } else { score -= v; }
    }
    score
}

/// Deterministic on-chain AI. One ply for level 1, two plies (opponent best
/// reply) for level 2. Never returns an illegal move (it only picks from the
/// legal list), so the AI can never cheat or blunder into an illegal state.
pub fn choose_ai_move(pos: &Position, level: u8) -> Option<Move> {
    let mut legal = MoveList::new();
    generate_legal_moves(pos, &mut legal);
    if legal.len == 0 { return None; }
    let mut best: Option<Move> = None;
    let mut best_score = i32::MIN;
    for i in 0..legal.len {
        let mv = legal.get(i);
        let np = make_move(pos, mv);
        let mut sc = -evaluate(&np);
        if level >= 2 {
            let mut reply = MoveList::new();
            generate_legal_moves(&np, &mut reply);
            if reply.len > 0 {
                let mut worst = i32::MAX;
                for j in 0..reply.len {
                    let np2 = make_move(&np, reply.get(j));
                    let s2 = -evaluate(&np2);
                    if s2 < worst { worst = s2; }
                }
                sc = -worst;
            }
        }
        if sc > best_score { best_score = sc; best = Some(mv); }
    }
    best
}

pub fn finish_board(b: &mut ChessBoard, result: u8, reason: u8, now: i64) {
    b.status = STATUS_FINISHED;
    b.result = result;
    b.end_reason = reason;
    b.finished_at = now;
    b.turn_started_at = now;
    b.check_flag = 0;
}

/// Spend the mover's clock, apply `mv`, update counters, and finish the game
/// if the move produced an end condition. Rejects any illegal move.
pub fn apply_move_to_board(b: &mut ChessBoard, mv: Move, now: i64) -> Result<()> {
    let pos = Position {
        squares: b.position,
        side: b.side_to_move,
        castling: b.castling,
        ep: b.ep,
        halfmove: b.halfmove,
        fullmove: b.fullmove,
    };
    let mut legal = MoveList::new();
    generate_legal_moves(&pos, &mut legal);
    let mut ok = false;
    for i in 0..legal.len {
        let m = legal.get(i);
        if m.from == mv.from && m.to == mv.to && m.promo == mv.promo { ok = true; break; }
    }
    if !ok { return Err(error!(PointsError::IllegalMove)); }

    let seat = b.side_to_move as usize;
    let elapsed = ((now - b.turn_started_at).max(0) as u64).saturating_mul(1000);
    let remaining = b.clock_ms[seat].saturating_sub(elapsed);
    b.clock_ms[seat] = remaining.saturating_add(b.increment_ms);
    b.turn_started_at = now;

    let np = make_move(&pos, mv);
    b.position = np.squares;
    b.side_to_move = np.side;
    b.castling = np.castling;
    b.ep = np.ep;
    b.halfmove = np.halfmove;
    b.fullmove = np.fullmove;
    b.move_count = b.move_count.saturating_add(1);
    b.last_hash = position_hash(&np);

    // Threefold repetition: count this position in the bounded history, then
    // store it (ring buffer). 128 plies covers every practical repetition.
    let mut rep = 1u32;
    let n = b.hist_len as usize;
    for i in 0..n {
        if b.history[i] == b.last_hash { rep += 1; }
    }
    let slot = (b.hist_pos as usize) % 128;
    b.history[slot] = b.last_hash;
    b.hist_pos = ((slot + 1) % 128) as u16;
    if n < 128 { b.hist_len = (n + 1) as u16; }

    if is_checkmate(&np) {
        let r = if seat == 0 { RESULT_WHITE } else { RESULT_BLACK };
        finish_board(b, r, REASON_CHECKMATE, now);
    } else if is_stalemate(&np) {
        finish_board(b, RESULT_DRAW, REASON_STALEMATE, now);
    } else if rep >= 3 {
        finish_board(b, RESULT_DRAW, REASON_THREEFOLD, now);
    } else if is_insufficient_material(&np) {
        finish_board(b, RESULT_DRAW, REASON_INSUFFICIENT, now);
    } else if is_fifty_move(&np) {
        finish_board(b, RESULT_DRAW, REASON_FIFTY, now);
    } else if b.move_count >= 300 {
        finish_board(b, RESULT_DRAW, REASON_PLY_CAP, now);
    } else {
        b.check_flag = if in_check(&np, np.side) { 1 } else { 0 };
    }
    Ok(())
}

// ---- contexts (instructions are wired in lib.rs) ----

#[derive(Accounts)]
#[instruction(match_ref: u64)]
pub struct InitializeChessMatch<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: host wallet (seat 0, the human; seat 1 is the house for solo).
    pub host: AccountInfo<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + ChessBoard::LEN,
        seeds = [CHESS_SEED, &match_ref.to_le_bytes()],
        bump
    )]
    pub board: Account<'info, ChessBoard>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateChessBoardInput<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the chess board PDA to delegate.
    #[account(mut, del)]
    pub board: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(match_ref: u64)]
pub struct StartChessMatch<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,
    #[account(mut, seeds = [CHESS_SEED, &match_ref.to_le_bytes()], bump)]
    pub board: Account<'info, ChessBoard>,
    #[account(mut, seeds = [CORE_SEED, signer.key().as_ref()], bump)]
    pub core: Box<Account<'info, PlayerCore>>,
}

#[derive(Accounts)]
#[instruction(match_ref: u64)]
pub struct MakeChessMove<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,
    #[account(mut, seeds = [CHESS_SEED, &match_ref.to_le_bytes()], bump)]
    pub board: Account<'info, ChessBoard>,
}

#[derive(Accounts)]
#[instruction(match_ref: u64)]
pub struct AiChessMove<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,
    #[account(mut, seeds = [CHESS_SEED, &match_ref.to_le_bytes()], bump)]
    pub board: Account<'info, ChessBoard>,
}

#[derive(Accounts)]
#[instruction(match_ref: u64)]
pub struct ClaimChessTimeout<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,
    #[account(mut, seeds = [CHESS_SEED, &match_ref.to_le_bytes()], bump)]
    pub board: Account<'info, ChessBoard>,
}

#[derive(Accounts)]
#[instruction(match_ref: u64)]
pub struct JoinChessMatch<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,
    #[account(mut, seeds = [CHESS_SEED, &match_ref.to_le_bytes()], bump)]
    pub board: Account<'info, ChessBoard>,
    #[account(mut, seeds = [CORE_SEED, signer.key().as_ref()], bump)]
    pub core: Box<Account<'info, PlayerCore>>,
}

/// Seat-holder action (resign, offer draw, accept draw). The handler checks the
/// signer is actually one of the two seats.
#[derive(Accounts)]
#[instruction(match_ref: u64)]
pub struct ChessSeatAction<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,
    #[account(mut, seeds = [CHESS_SEED, &match_ref.to_le_bytes()], bump)]
    pub board: Account<'info, ChessBoard>,
}

#[commit]
#[derive(Accounts)]
#[instruction(match_ref: u64)]
pub struct CommitAndUndelegateChessBoard<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [CHESS_SEED, &match_ref.to_le_bytes()], bump)]
    pub board: Account<'info, ChessBoard>,
}

// ---------- tests (host): perft + rules ----------

#[cfg(test)]
mod tests {
    use super::*;

    fn perft_fen(fen: &str, depth: u32) -> u64 {
        perft(&parse_fen(fen), depth)
    }

    #[test]
    fn perft_startpos() {
        assert_eq!(perft(&Position::initial(), 1), 20);
        assert_eq!(perft(&Position::initial(), 2), 400);
        assert_eq!(perft(&Position::initial(), 3), 8902);
        assert_eq!(perft(&Position::initial(), 4), 197281);
    }

    #[test]
    fn perft_kiwipete() {
        let fen = "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1";
        assert_eq!(perft_fen(fen, 1), 48);
        assert_eq!(perft_fen(fen, 2), 2039);
        assert_eq!(perft_fen(fen, 3), 97862);
    }

    #[test]
    fn perft_position3() {
        let fen = "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1";
        assert_eq!(perft_fen(fen, 1), 14);
        assert_eq!(perft_fen(fen, 2), 191);
        assert_eq!(perft_fen(fen, 3), 2812);
    }

    #[test]
    fn perft_position4() {
        let fen = "r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1";
        assert_eq!(perft_fen(fen, 1), 6);
        assert_eq!(perft_fen(fen, 2), 264);
        assert_eq!(perft_fen(fen, 3), 9467);
    }

    #[test]
    fn perft_position5() {
        let fen = "rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8";
        assert_eq!(perft_fen(fen, 1), 44);
        assert_eq!(perft_fen(fen, 2), 1486);
        assert_eq!(perft_fen(fen, 3), 62379);
    }

    #[test]
    fn perft_position6() {
        let fen = "r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10";
        assert_eq!(perft_fen(fen, 1), 46);
        assert_eq!(perft_fen(fen, 2), 2079);
        assert_eq!(perft_fen(fen, 3), 89890);
    }

    #[test]
    fn back_rank_checkmate() {
        let fen = "6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1";
        let pos = parse_fen(fen);
        let mut l = MoveList::new();
        generate_legal_moves(&pos, &mut l);
        let mut mated = false;
        for i in 0..l.len {
            let m = l.get(i);
            if m.from == 0 && m.to == 56 { mated = true; }
        }
        assert!(mated, "Ra8 available");
        let after = make_move(&pos, Move { from: 0, to: 56, promo: 0 });
        assert!(is_checkmate(&after), "black is checkmated");
    }

    #[test]
    fn stalemate_detected() {
        let fen = "7k/5Q2/6K1/8/8/8/8/8 b - - 0 1";
        let pos = parse_fen(fen);
        assert!(is_stalemate(&pos), "black stalemated");
        assert!(!in_check(&pos, BLACK));
    }

    #[test]
    fn en_passant_works() {
        let fen = "rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3";
        let pos = parse_fen(fen);
        let after = make_move(&pos, Move { from: 36, to: 45, promo: 0 }); // e5xf6 e.p.
        assert_eq!(after.squares[37], EMPTY, "captured pawn removed");
        assert_eq!(after.squares[45], WP);
    }

    #[test]
    fn promotion_generates_four() {
        let fen = "8/P6k/8/8/8/8/6K1/8 w - - 0 1";
        let pos = parse_fen(fen);
        let mut l = MoveList::new();
        generate_legal_moves(&pos, &mut l);
        let mut count = 0;
        for i in 0..l.len { if l.get(i).from == 48 && l.get(i).to == 56 { count += 1; } }
        assert_eq!(count, 4, "N B R Q promotions");
    }

    #[test]
    fn threefold_repetition_draws() {
        let init = Position::initial();
        let mut b = ChessBoard {
            version: 1, game: CHESS_TAG, status: STATUS_PLAYING, seat_count: 2,
            result: RESULT_NONE, end_reason: REASON_NONE,
            side_to_move: WHITE, castling: INITIAL_CASTLING, ep: NO_EP, check_flag: 0,
            seats: [Pubkey::default(); 2],
            position: init.squares,
            clock_ms: [600000, 600000], increment_ms: 0,
            turn_started_at: 0, started_at: 0, finished_at: 0,
            halfmove: 0, fullmove: 1, move_count: 0, last_hash: 0,
            history: [0u64; 128], hist_len: 0, hist_pos: 0,
            draw_offer: 255, last_request_ref: 0, bump: 0,
        };
        // Knight shuffle back to the start position three times.
        let seq = [(6u8, 21u8), (62, 45), (21, 6), (45, 62)];
        let mut now = 100i64;
        for _cycle in 0..3 {
            for (f, t) in seq {
                now += 1;
                apply_move_to_board(&mut b, Move { from: f, to: t, promo: 0 }, now).unwrap();
            }
        }
        assert_eq!(b.status, STATUS_FINISHED, "game finished");
        assert_eq!(b.end_reason, REASON_THREEFOLD, "threefold draw");
        assert_eq!(b.result, RESULT_DRAW);
    }

    #[test]
    fn chessboard_len_matches_borsh() {
        use anchor_lang::AnchorSerialize;
        let b = ChessBoard {
            version: 0, game: 0, status: 0, seat_count: 0, result: 0, end_reason: 0,
            side_to_move: 0, castling: 0, ep: 0, check_flag: 0,
            seats: [Pubkey::default(); 2],
            position: [0u8; 64],
            clock_ms: [0u64; 2],
            increment_ms: 0, turn_started_at: 0, started_at: 0, finished_at: 0,
            halfmove: 0, fullmove: 0, move_count: 0, last_hash: 0,
            history: [0u64; 128], hist_len: 0, hist_pos: 0,
            draw_offer: 0, last_request_ref: 0, bump: 0,
        };
        let mut buf = Vec::new();
        b.serialize(&mut buf).unwrap();
        assert_eq!(buf.len(), ChessBoard::LEN);
    }
}
