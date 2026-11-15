"""Python rules and opponent for the web Gomoku board."""

SIZE = 15
DIRECTIONS = ((0, 1), (1, 0), (1, 1), (1, -1))
DIFFICULTIES = ('easy', 'standard', 'challenge')


def inside(row, col):
    return 0 <= row < SIZE and 0 <= col < SIZE


def read_position(move):
    if not isinstance(move, dict):
        raise ValueError('落子格式无效。')
    row, col = move.get('row'), move.get('col')
    if type(row) is not int or type(col) is not int or not inside(row, col):
        raise ValueError('请选择棋盘内的交叉点。')
    return row, col


def winning_positions(board, row, col, player):
    positions = []
    for row_step, col_step in DIRECTIONS:
        line = [(row, col)]
        for sign in (-1, 1):
            r, c = row + sign * row_step, col + sign * col_step
            while inside(r, c) and board[r][c] == player:
                line.append((r, c))
                r += sign * row_step
                c += sign * col_step
        if len(line) >= 5:
            positions.extend(line)
    return list(dict.fromkeys(positions))


def placement_score(board, row, col, player):
    """Score five-cell windows that a move could use, including broken lines."""
    weights = (0, 0, 3, 18, 95, 100_000)
    score = 0
    threats = set()
    for row_step, col_step in DIRECTIONS:
        for offset in range(-4, 1):
            first_row = row + offset * row_step
            first_col = col + offset * col_step
            last_row = first_row + 4 * row_step
            last_col = first_col + 4 * col_step
            if not inside(first_row, first_col) or not inside(last_row, last_col):
                continue
            vacant = []
            for index in range(5):
                r = first_row + index * row_step
                c = first_col + index * col_step
                if (r, c) == (row, col) or board[r][c] == player:
                    continue
                if board[r][c] is not None:
                    break
                vacant.append((r, c))
            else:
                score += weights[5 - len(vacant)]
                if len(vacant) == 1:
                    threats.add(vacant[0])
    if len(threats) > 1:
        score += 500
    return score


def reply_strength(board, row, col):
    """Evaluate Black's strongest reply after a proposed White move."""
    board[row][col] = 'white'
    try:
        white_finishes = 0
        black_reply = 0
        for r in range(SIZE):
            for c in range(SIZE):
                if board[r][c] is not None:
                    continue
                if winning_positions(board, r, c, 'black'):
                    return 100_000
                if winning_positions(board, r, c, 'white'):
                    white_finishes += 1
                black_reply = max(black_reply, placement_score(board, r, c, 'black'))
        if white_finishes >= 2:
            return -100_000
        if white_finishes == 1:
            return 0
        return black_reply
    finally:
        board[row][col] = None


def computer_move(board, difficulty='standard'):
    center = SIZE // 2
    candidates = []
    for row in range(SIZE):
        for col in range(SIZE):
            if board[row][col] is not None:
                continue
            if winning_positions(board, row, col, 'white'):
                return row, col
            attack = placement_score(board, row, col, 'white')
            distance = (row - center) ** 2 + (col - center) ** 2
            if difficulty == 'easy':
                rank = (attack, -distance)
            else:
                blocks_win = bool(winning_positions(board, row, col, 'black'))
                defense = placement_score(board, row, col, 'black')
                rank = (blocks_win, max(attack, defense) * 2 + attack + defense, -distance)
            candidates.append((rank, (row, col)))
    if not candidates:
        return None
    candidates.sort(key=lambda candidate: candidate[0], reverse=True)
    if difficulty == 'challenge':
        return max(candidates[:8], key=lambda candidate: (
            -reply_strength(board, *candidate[1]), candidate[0],
        ))[1]
    return candidates[0][1]


class Game:
    def __init__(self, history):
        self.board = [[None] * SIZE for _ in range(SIZE)]
        self.history = []
        self.winner = None
        self.winning = []
        for move in history:
            row, col = read_position(move)
            if move.get('player') != self.turn:
                raise ValueError('棋谱的黑白落子顺序有误。')
            self.place(row, col)

    @property
    def turn(self):
        return 'white' if len(self.history) % 2 else 'black'

    def place(self, row, col):
        if self.winner:
            raise ValueError('本局已结束，请重新开局或悔棋。')
        if self.board[row][col] is not None:
            raise ValueError('此处已有棋子，请选择其他位置。')
        player = self.turn
        self.board[row][col] = player
        self.history.append({'row': row, 'col': col, 'player': player})
        self.winning = winning_positions(self.board, row, col, player)
        if self.winning:
            self.winner = player
        elif len(self.history) == SIZE * SIZE:
            self.winner = 'draw'

    def state(self):
        return {
            'history': self.history,
            'turn': self.turn,
            'winner': self.winner,
            'winning': [{'row': row, 'col': col} for row, col in self.winning],
        }


def play(payload):
    if not isinstance(payload, dict):
        raise ValueError('请求格式无效。')
    mode, action, history = payload.get('mode'), payload.get('action'), payload.get('history')
    if mode not in ('computer', 'local'):
        raise ValueError('请选择人机对弈或双人对弈。')
    if action not in ('move', 'undo', 'state'):
        raise ValueError('未知的棋局操作。')
    difficulty = payload.get('difficulty', 'standard')
    if difficulty not in DIFFICULTIES:
        raise ValueError('请选择有效的人机难度。')
    if not isinstance(history, list) or len(history) > SIZE * SIZE:
        raise ValueError('棋谱格式无效。')
    game = Game(history)
    if action == 'undo' and history:
        steps = 2 if mode == 'computer' and game.turn == 'black' else 1
        game = Game(history[:-steps])
    if action == 'move':
        if mode == 'computer' and game.turn != 'black' and not game.winner:
            raise ValueError('当前轮到电脑落子，请先悔棋或重新开局。')
        game.place(*read_position(payload))
        if mode == 'computer' and not game.winner:
            game.place(*computer_move(game.board, difficulty))
    return game.state()
