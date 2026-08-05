class MilacloneError(Exception):
    def __init__(self, message: str, raw: object = None):
        super().__init__(message)
        self.raw = raw


class AuthError(MilacloneError):
    pass


class NotFoundError(MilacloneError):
    pass
