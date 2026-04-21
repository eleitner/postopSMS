import { http } from '@google-cloud/functions-framework';
import { handleCreateSession } from './handler';

http('createSession', handleCreateSession);
