import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Permission } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { checkAccess } from 'src/utils/access.js';

// Owner, editor, viewer or the album's shared link (trips PLAN D7). Anyone else gets 404, as for a missing album.
export const requireTripRead = async (access: AccessRepository, auth: AuthDto, albumId: string) => {
  const allowed = await checkAccess(access, { auth, permission: Permission.AlbumRead, ids: [albumId] });
  if (!allowed.has(albumId)) {
    throw new NotFoundException('Trip not found');
  }
};

// A reader who is not the album owner gets 403; anyone else 404, as for a missing album.
export const requireAlbumOwner = async (access: AccessRepository, auth: AuthDto, albumId: string, message: string) => {
  await requireTripRead(access, auth, albumId);
  const isOwner = await access.album.checkOwnerAccess(auth.user.id, new Set([albumId]));
  if (auth.sharedLink || !isOwner.has(albumId)) {
    throw new ForbiddenException(message);
  }
};
